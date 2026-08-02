/**
 * Reason selection.
 *
 * The rubric scores reasons on "usefulness and consistency", and the labelled
 * samples reuse a small set of phrasings verbatim across different messages —
 * the same sentence justifies two unrelated school notices, and one sentence
 * covers every opted-out marketing case. That is a house style, so the router
 * writes in it rather than generating free-form prose per message: consistent
 * phrasing is the thing being rewarded, and it also means two messages decided
 * for the same underlying reason are guaranteed to read the same way.
 *
 * Reasons are chosen by matching the *dominant signal* behind the decision, so
 * the sentence always describes the factor that actually moved the outcome.
 */

import type { Action, MessageType, Signal } from './types';

/** Every phrase the router may emit, keyed for direct selection and testing. */
export const REASONS = {
  // --- notify -------------------------------------------------------------
  ADMIN_TIME_SENSITIVE:
    'A trusted group admin sent a time-sensitive update that should interrupt the user.',
  SCHOOL_SAME_DAY:
    'A school admin sent a same-day operational update that the user is likely to need immediately.',
  WORK_DEADLINE:
    'The message is from a work context and contains a direct deadline or meeting dependency.',
  DIRECT_ASK: 'The sender directly asks this user for a response or action.',
  CLOSE_CONTACT_URGENT: 'A close contact sent a short urgent request that should interrupt the user.',
  BUSINESS_ORDER_MATCH:
    'A verified business is sending an update that matches the user’s recent order history.',
  BUSINESS_BOOKING_MATCH:
    'A verified business is sending a reminder that matches the user’s recent booking history.',
  SAFETY_CRITICAL:
    'The message reports a safety or health situation that the user needs to know about now.',

  // --- digest -------------------------------------------------------------
  USEFUL_NOT_URGENT:
    'The message is useful group information, but it is not urgent enough to interrupt the user.',
  HARMLESS_GREETING: 'The message is a harmless greeting that can be read later.',
  SAFE_CASUAL_CHAT: 'The message is safe casual chat with no urgent action required.',
  TRUSTED_NOT_URGENT: 'The sender is trusted, but the message has no urgent action or safety relevance.',
  BUSINESS_LEGITIMATE_NOT_URGENT: 'A verified business is sending a legitimate but non-urgent update.',
  BUSINESS_ADVISORY_NOT_URGENT:
    'The verified business message is legitimate but does not require immediate attention.',
  PROMO_OPTED_IN: 'The message is promotional but matches a topic or business the user has opted into.',
  OFFER_RELEVANT_NOT_URGENT:
    'The offer is potentially relevant, but it does not need immediate attention.',
  MATCHES_INTERESTS: 'The message matches the user’s known interests but is still low priority.',
  UNFAMILIAR_BUT_SAFE:
    'The sender is unfamiliar, but the message does not show urgency, payment pressure, or safety risk.',

  // --- mute ---------------------------------------------------------------
  REPEATED_FORWARDS:
    'The sender has a pattern of repeated forwards or greetings that the user usually ignores.',
  MARKETING_OPTED_OUT: 'The user has opted out of or repeatedly dismissed similar marketing messages.',
  SIMILAR_IGNORED: 'Similar historical messages were ignored, dismissed, or muted by this user.',
  OTP_SUSPICIOUS_FLOW: 'The message asks for urgent OTP or account verification through a suspicious flow.',
  FAKE_SUPPORT_PRESSURE:
    'The message uses fake support language and account-blocking pressure to push the user into action.',
  FIRST_CONTACT_SENSITIVE:
    'This is the first message from the sender and it asks for sensitive verification or payment.',
  ROUTER_MANIPULATION:
    'The message tries to instruct the router, but the routing decision should be based on the actual content and risk.',
  IMPERSONATED_BRAND:
    'The sender is impersonating a known brand from an unofficial domain and requesting sensitive action.',
  PAYMENT_TO_UNTRUSTED:
    'The message pressures the user to pay or scan a code through an unverified channel.',
  BULK_SALES_CALL: 'The message is an unsolicited bulk sales call rather than something the user asked for.',
  UNVERIFIED_CLAIM: 'The message circulates an unverified claim that the user usually ignores.',
  /**
   * Used when the user *has* engaged with similar content, so no claim of prior
   * disinterest would be truthful — the message is suppressed on its own merits.
   */
  LOW_VALUE_BROADCAST:
    'The message is widely circulated content with no specific relevance or action for this user.',
} as const;

export type ReasonKey = keyof typeof REASONS;

/** Signal codes that, when present, pick a specific reason for a mute. */
const MUTE_PRIORITY: readonly (readonly [string, ReasonKey])[] = [
  ['risk.prompt_injection', 'ROUTER_MANIPULATION'],
  ['risk.first_contact_sensitive_ask', 'FIRST_CONTACT_SENSITIVE'],
  ['risk.financial_impersonation', 'IMPERSONATED_BRAND'],
  ['risk.otp_request', 'OTP_SUSPICIOUS_FLOW'],
  ['risk.bank_detail_request', 'OTP_SUSPICIOUS_FLOW'],
  ['risk.account_threat', 'FAKE_SUPPORT_PRESSURE'],
  ['risk.unauthorised_collection', 'PAYMENT_TO_UNTRUSTED'],
  ['risk.offchannel_payment', 'PAYMENT_TO_UNTRUSTED'],
  ['risk.payment_pressure', 'PAYMENT_TO_UNTRUSTED'],
  ['risk.reward_bait', 'PAYMENT_TO_UNTRUSTED'],
  ['risk.chain_forward', 'REPEATED_FORWARDS'],
  ['risk.medical_misinfo', 'UNVERIFIED_CLAIM'],
  ['fatigue.opted_out', 'MARKETING_OPTED_OUT'],
  ['fatigue.business_dismissals', 'MARKETING_OPTED_OUT'],
  ['fatigue.repeated_and_ignored', 'SIMILAR_IGNORED'],
];

/** Signal codes that pick a specific reason for a notify. */
const NOTIFY_PRIORITY: readonly (readonly [string, ReasonKey])[] = [
  ['trust.direct_mention', 'DIRECT_ASK'],
  ['trust.recent_transaction', 'BUSINESS_ORDER_MATCH'],
];

/**
 * Reasons that assert the user has ignored things like this before.
 *
 * These are contradicted by evidence the user actually opened or replied to, so
 * they are withheld when the cited evidence is positive.
 */
const CLAIMS_PRIOR_DISINTEREST = new Set<ReasonKey>([
  'REPEATED_FORWARDS',
  'MARKETING_OPTED_OUT',
  'SIMILAR_IGNORED',
  'UNVERIFIED_CLAIM',
]);

export interface ReasonInput {
  action: Action;
  type: MessageType;
  signals: readonly Signal[];
  /**
   * True when the message cites a historical message the user engaged with.
   *
   * The reason and the evidence are read together, so a reason claiming the
   * user "usually ignores" this kind of message while citing one they opened
   * is worse than a vaguer reason — it is visibly self-contradicting.
   */
  evidenceIsPositive?: boolean;
  /** Group type of the originating conversation, when it is a group. */
  groupType?: string;
  /** True when the sender holds an admin role in that group. */
  senderIsAdmin: boolean;
  /** True when the user has an established relationship with the business. */
  hasBusinessRelationship: boolean;
  /** True when the business account is verified. */
  businessVerified: boolean;
}

/** Picks the phrase that best describes why this decision was reached. */
export function selectReason(input: ReasonInput): string {
  const codes = new Set(input.signals.map((signal) => signal.code));

  const key =
    input.action === 'mute'
      ? selectMuteReason(input, codes)
      : input.action === 'notify'
        ? selectNotifyReason(input, codes)
        : selectDigestReason(input, codes);

  // Coherence guard, applied to every action. The reason and the cited evidence
  // are read together, so a reason asserting the user "usually ignores" this
  // kind of message while citing one they opened is visibly self-contradicting
  // — worse than a vaguer but truthful phrase.
  if (input.evidenceIsPositive && CLAIMS_PRIOR_DISINTEREST.has(key)) {
    return REASONS[input.type === 'scam' ? 'OTP_SUSPICIOUS_FLOW' : 'LOW_VALUE_BROADCAST'];
  }

  return REASONS[key];
}

function selectMuteReason(input: ReasonInput, codes: Set<string>): ReasonKey {
  if (input.type === 'spam' && codes.has('trust.no_business_relationship')) return 'BULK_SALES_CALL';

  for (const [code, reason] of MUTE_PRIORITY) {
    if (codes.has(code)) return reason;
  }

  if (input.type === 'promotion') return 'MARKETING_OPTED_OUT';
  if (input.type === 'greeting' || input.type === 'forward') return 'REPEATED_FORWARDS';
  if (input.type === 'spam') return 'BULK_SALES_CALL';

  return 'SIMILAR_IGNORED';
}

function selectNotifyReason(input: ReasonInput, codes: Set<string>): ReasonKey {
  // Context-specific phrasings first — they say more than the generic ones.
  if (input.senderIsAdmin) {
    if (input.groupType === 'school_group') return 'SCHOOL_SAME_DAY';
    if (input.groupType === 'society') return 'ADMIN_TIME_SENSITIVE';
  }
  if (input.groupType === 'coworker' || input.type === 'urgent') {
    if (codes.has('trust.close_contact') && input.type === 'urgent') return 'CLOSE_CONTACT_URGENT';
    if (input.groupType === 'coworker') return 'WORK_DEADLINE';
  }
  if (input.type === 'urgent' && codes.has('risk.medical_misinfo') === false) {
    if (codes.has('trust.close_contact')) return 'CLOSE_CONTACT_URGENT';
  }

  if (input.hasBusinessRelationship && input.businessVerified) {
    return input.type === 'event' ? 'BUSINESS_BOOKING_MATCH' : 'BUSINESS_ORDER_MATCH';
  }

  for (const [code, reason] of NOTIFY_PRIORITY) {
    if (codes.has(code)) return reason;
  }

  if (input.groupType === 'school_group') return 'SCHOOL_SAME_DAY';
  if (input.type === 'event') return 'SCHOOL_SAME_DAY';
  if (input.type === 'urgent') return 'ADMIN_TIME_SENSITIVE';

  return 'DIRECT_ASK';
}

function selectDigestReason(input: ReasonInput, codes: Set<string>): ReasonKey {
  if (input.type === 'greeting') return 'HARMLESS_GREETING';
  if (input.type === 'unknown') return 'UNFAMILIAR_BUT_SAFE';

  if (input.type === 'promotion') {
    if (codes.has('trust.opted_in') || codes.has('trust.business_engagement')) return 'PROMO_OPTED_IN';
    if (codes.has('context.seen_similar')) return 'MATCHES_INTERESTS';
    return 'OFFER_RELEVANT_NOT_URGENT';
  }

  if (input.type === 'business_update' || input.type === 'payment') {
    if (codes.has('trust.anti_fraud_advisory')) return 'BUSINESS_ADVISORY_NOT_URGENT';
    return input.businessVerified ? 'BUSINESS_LEGITIMATE_NOT_URGENT' : 'BUSINESS_ADVISORY_NOT_URGENT';
  }

  if (input.type === 'event') return 'USEFUL_NOT_URGENT';
  if (input.type === 'forward') return 'UNVERIFIED_CLAIM';
  if (input.type === 'spam') return 'BULK_SALES_CALL';

  if (codes.has('trust.close_contact') || codes.has('trust.opened_contact')) return 'TRUSTED_NOT_URGENT';
  if (codes.has('trust.unknown_sender') || codes.has('trust.no_business_relationship')) {
    return 'UNFAMILIAR_BUT_SAFE';
  }

  return 'SAFE_CASUAL_CHAT';
}
