/**
 * What the sender is asking the recipient to do.
 *
 * Distinct from risk (is this safe?) and trust (do we care about this sender?).
 * Intent is about the message's own demand on the reader's attention, and it is
 * the term that separates two messages from the same trusted admin in the same
 * group where one needs an answer in ten minutes and the other is a form that
 * closes next Sunday.
 *
 * Senders in this corpus are unusually explicit about it — "no rush", "nothing
 * urgent", "reply once here", "before EOD" — so taking them at their word is
 * both accurate and the behaviour a user would want.
 */

import { DEFERRABLE, IMMEDIATE_URGENCY, RESPONSE_REQUESTED } from './lexicons';
import type { ResolvedContent, Signal } from './types';

export interface IntentAssessment {
  /** Positive pushes towards `notify`, negative towards `digest`. */
  score: number;
  signals: Signal[];
  /** Needs action within minutes or hours. */
  isUrgent: boolean;
  /** The sender explicitly said it can wait. */
  isDeferrable: boolean;
  /** Asks this recipient for a reply or action. */
  requestsResponse: boolean;
  /** Refers to something happening today or tomorrow. */
  isTimeAnchored: boolean;
}

const test = (patterns: readonly RegExp[], haystack: string): boolean =>
  patterns.some((pattern) => pattern.test(haystack));

export function assessIntent(content: ResolvedContent): IntentAssessment {
  const signals: Signal[] = [];
  const haystack = content.haystack;
  const mediaSignals = new Set(content.mediaSignals);
  let score = 0;

  const isDeferrable =
    test(DEFERRABLE.patterns, haystack) || mediaSignals.has('explicitly_not_urgent');

  const isUrgent =
    !isDeferrable &&
    (test(IMMEDIATE_URGENCY.patterns, haystack) ||
      mediaSignals.has('time_critical') ||
      mediaSignals.has('production_outage') ||
      mediaSignals.has('family_health_emergency') ||
      mediaSignals.has('immediate_call_request'));

  const requestsResponse =
    test(RESPONSE_REQUESTED.patterns, haystack) ||
    mediaSignals.has('response_requested') ||
    mediaSignals.has('direct_request_to_user');

  // Anchored to a near-term moment the user has to be ready for. Distinct from
  // urgency: "your parcel arrives today" demands no action within minutes, but
  // it is still worth surfacing now in a way that "rate your experience" is not.
  const isTimeAnchored =
    /\b(today|tonight|tomorrow|this (morning|afternoon|evening)|within the (hour|next))\b/i.test(
      haystack,
    ) ||
    mediaSignals.has('dated_commitment') ||
    mediaSignals.has('booking_change') ||
    mediaSignals.has('logistics_change');

  if (isUrgent) {
    score += 0.3;
    signals.push({
      code: 'intent.immediate_urgency',
      label: 'Needs the user to act within minutes or hours',
      weight: 0.3,
    });
  }

  if (isDeferrable) {
    // Honouring "no rush" is the whole point of having a digest tier. A sender
    // who says it can wait has effectively pre-classified their own message.
    score -= 0.28;
    signals.push({
      code: 'intent.deferrable',
      label: 'Sender explicitly says the message can wait',
      weight: -0.28,
    });
  }

  if (requestsResponse) {
    // A question still needs answering even when the sender softens it with
    // "no rush" — the politeness sets the tempo, it does not remove the ask.
    const weight = isDeferrable ? 0.08 : 0.12;
    score += weight;
    signals.push({
      code: 'intent.response_requested',
      label: 'Asks this user for a reply or an action',
      weight,
    });
  }

  // A direct ask carrying a same-day clock deadline. Neither half warrants an
  // interruption alone — plenty of messages mention a time, and plenty ask a
  // question — but "can you collect it by 6 PM, tell me if you can't" is a
  // decision someone is actively waiting on, and it expires today. Gated on
  // `requestsResponse` so a bare timetable is not mistaken for a demand.
  const hasSameDayDeadline =
    /\b(by|before|till|until|upto|up to)\b[ \t]*\d{1,2}[:.]?\d{0,2} ?(am|pm|o'clock|baje)\b/i.test(
      haystack,
    ) || /\b(by|before)\b[ \t]*(today|tonight|end of day|eod)\b/i.test(haystack);

  if (hasSameDayDeadline && requestsResponse && !isDeferrable) {
    score += 0.14;
    signals.push({
      code: 'intent.same_day_deadline',
      label: 'Asks for a response against a deadline that expires today',
      weight: 0.14,
    });
  }

  if (isTimeAnchored && !isDeferrable) {
    score += 0.1;
    signals.push({
      code: 'intent.time_anchored',
      label: 'Refers to something happening today or tomorrow',
      weight: 0.1,
    });
  }

  return { score, signals, isUrgent, isDeferrable, requestsResponse, isTimeAnchored };
}
