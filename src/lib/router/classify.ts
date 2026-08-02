/**
 * Message categorisation.
 *
 * `message_type` is scored separately from `action` because the two answer
 * different questions — a `promotion` can be any of the three actions depending
 * on the user, and a `scam` is always muted. Deriving one from the other would
 * collapse that distinction and lose accuracy on both.
 *
 * The rules are ordered by decisiveness: safety categories first (they are
 * conclusive), then structural ones the sender made explicit (a chain forward,
 * a greeting), then intent, and finally the conversational default. Each branch
 * returns immediately, so the ordering *is* the precedence.
 */

import {
  BUSINESS_UPDATE,
  DEFERRABLE,
  EVENT,
  GREETING,
  IMMEDIATE_URGENCY,
  PAYMENT_LEGITIMATE,
  PROMOTION,
  RESPONSE_REQUESTED,
  STRANGER_INTRO,
} from './lexicons';
import type { RiskAssessment } from './risk';
import type { Message, MessageType, ResolvedContent, RouterContext } from './types';
import type { TrustAssessment } from './trust';

export interface Classification {
  type: MessageType;
  /** Why this category won, for the explainability panel. */
  rationale: string;
}

const test = (patterns: readonly RegExp[], haystack: string): boolean =>
  patterns.some((pattern) => pattern.test(haystack));

/** Media signals that mark a recorded bulk sales call rather than a message. */
const TELEMARKETING_SIGNALS = new Set([
  'recorded_telemarketing',
  'ivr_call_to_action',
  'unsolicited_bulk',
]);

export function classify(
  message: Message,
  content: ResolvedContent,
  risk: RiskAssessment,
  trust: TrustAssessment,
  context: RouterContext,
): Classification {
  const haystack = content.haystack;
  const mediaSignals = new Set(content.mediaSignals);

  // --- Safety categories ---------------------------------------------------

  if (risk.isScam) {
    return {
      type: 'scam',
      rationale: risk.isInjection
        ? 'Attempts to instruct the router while requesting sensitive details'
        : 'Combines a credential or payment demand with manufactured urgency',
    };
  }

  // Bulk nuisance that is not targeted fraud.
  const isTelemarketing = [...mediaSignals].some((signal) => TELEMARKETING_SIGNALS.has(signal));
  if (isTelemarketing) {
    return { type: 'spam', rationale: 'Recorded bulk sales call rather than a personal message' };
  }

  if (risk.isSpam && risk.firedCodes.has('risk.medical_misinfo')) {
    return { type: 'forward', rationale: 'Circulated health claim with no verifiable source' };
  }

  // --- Structural categories the sender made explicit ----------------------

  const heavilyForwarded = message.forwarded_count >= 5;
  const isGreeting = test(GREETING.patterns, haystack);
  const isChain = risk.firedCodes.has('risk.chain_forward');

  // A forwarded blessing is still a greeting — that is how the sample data
  // labels it. Only forwarded content that is *not* a greeting reads as
  // `forward`, so this check has to come first.
  if (isGreeting && (isChain || heavilyForwarded || !test(RESPONSE_REQUESTED.patterns, haystack))) {
    return { type: 'greeting', rationale: 'Well-wishing content with no specific ask' };
  }

  if (isChain || (heavilyForwarded && !trust.directlyAddressed)) {
    return { type: 'forward', rationale: 'Mass-forwarded content passed along unchanged' };
  }

  // --- Commercial categories ----------------------------------------------

  const looksPromotional =
    test(PROMOTION.patterns, haystack) ||
    mediaSignals.has('price_promotion') ||
    mediaSignals.has('real_estate_offer') ||
    mediaSignals.has('travel_offer') ||
    mediaSignals.has('investment_solicitation');

  const looksTransactional =
    test(BUSINESS_UPDATE.patterns, haystack) ||
    mediaSignals.has('booking_change') ||
    mediaSignals.has('delivery_packaging');

  // A transactional update wins over a promotional flourish: "your order has
  // shipped, and here's 10% off" is an order update, not an advert.
  if (message.conversation_type === 'business') {
    if (looksTransactional && !isPurelyPromotional(haystack)) {
      // A dated commitment inside a business message is an event, which is how
      // the sample labels appointment and booking reminders.
      if (mediaSignals.has('booking_change') || isAppointment(haystack)) {
        return { type: 'event', rationale: 'Business message about a scheduled appointment or booking' };
      }
      return { type: 'business_update', rationale: 'Transactional update from a business account' };
    }
    if (isStatement(haystack)) {
      return { type: 'payment', rationale: 'Account statement or amount due from a business' };
    }
    if (looksPromotional) {
      return { type: 'promotion', rationale: 'Marketing content from a business account' };
    }
    return { type: 'business_update', rationale: 'Non-promotional message from a business account' };
  }

  // --- Intent categories ---------------------------------------------------

  const urgentNow =
    test(IMMEDIATE_URGENCY.patterns, haystack) ||
    mediaSignals.has('time_critical') ||
    mediaSignals.has('production_outage') ||
    mediaSignals.has('family_health_emergency');

  const deferrable = test(DEFERRABLE.patterns, haystack) || mediaSignals.has('explicitly_not_urgent');

  // A peer-to-peer sale is a promotion even though it mentions a pickup time
  // and place. Checked before the event branch because "collect it from Gate 2
  // by 6 PM" otherwise reads as logistics rather than as the sale it is.
  if (isPeerSale(haystack) || mediaSignals.has('resale_listing')) {
    return { type: 'promotion', rationale: 'Peer-to-peer sale or resale listing' };
  }

  // Money owed inside a group, where the sender is a legitimate admin.
  if (test(PAYMENT_LEGITIMATE.patterns, haystack) && isMoneyDue(haystack) && !risk.isScam) {
    return { type: 'payment', rationale: 'Legitimate request to settle an amount that is due' };
  }

  const isEvent = test(EVENT.patterns, haystack) || mediaSignals.has('scheduled_meeting') ||
    mediaSignals.has('school_document') || mediaSignals.has('consent_form') ||
    mediaSignals.has('logistics_change') || mediaSignals.has('dated_commitment');

  if (urgentNow && !deferrable) {
    // Something scheduled that has just moved is still urgent when it is
    // happening today; the urgency is the actionable part.
    return { type: 'urgent', rationale: 'Requires the user to act within minutes or hours' };
  }

  if (isEvent) {
    return { type: 'event', rationale: 'Refers to a dated commitment the user has to plan around' };
  }

  if (looksPromotional) {
    return { type: 'promotion', rationale: 'Offers goods or services for sale' };
  }

  if (isGreeting) {
    return { type: 'greeting', rationale: 'Well-wishing content with no specific ask' };
  }

  // --- Fallbacks -----------------------------------------------------------

  // The sample uses `unknown` for a stranger with a benign, unclassifiable ask.
  const noHistory = (context.historyByUser.get(message.user_id) ?? []).every(
    (past) => past.sender_user_id !== message.sender_user_id,
  );
  if (noHistory && test(STRANGER_INTRO.patterns, haystack)) {
    return { type: 'unknown', rationale: 'Unfamiliar sender with no classifiable intent' };
  }

  if (
    message.conversation_type === 'personal' ||
    trust.directlyAddressed ||
    test(RESPONSE_REQUESTED.patterns, haystack)
  ) {
    return { type: 'personal', rationale: 'Direct human conversation with this user' };
  }

  if (message.conversation_type === 'group') {
    return { type: 'personal', rationale: 'Ordinary group conversation' };
  }

  return { type: 'unknown', rationale: 'No category fits confidently' };
}

/** True when the message is advertising and nothing else. */
function isPurelyPromotional(haystack: string): boolean {
  const promotional = /\b\d{1,3} ?% ?off\b|\bdiscount\b|\bsale\b|\bcashback\b|\bwelcome offer\b/i.test(
    haystack,
  );
  const transactional = /\b(your order|your booking|your ride|delivery|shipment|statement|refund|appointment)\b/i.test(
    haystack,
  );
  return promotional && !transactional;
}

function isAppointment(haystack: string): boolean {
  return /\b(appointment|prescription|claim|pickup|booking|reservation|scheduled)\b/i.test(haystack);
}

function isStatement(haystack: string): boolean {
  return /\b(statement|amount due|payment date|reward points|bill|invoice|emi)\b/i.test(haystack);
}

function isMoneyDue(haystack: string): boolean {
  return /\b(due|pending|before \d|by \d|late fee|maintenance|receipt|clearance)\b/i.test(haystack);
}

/** True for a person selling something to their own group. */
function isPeerSale(haystack: string): boolean {
  return /\b(selling|for sale|dm if interested|price is|barely used|not using it|buyer cancelled|pickup near)\b/i.test(
    haystack,
  );
}
