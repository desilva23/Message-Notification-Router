/**
 * Safety scoring.
 *
 * Produces a 0–1 risk score plus the signals that justify it. The engine treats
 * a high score as an override rather than a vote: the specification is explicit
 * that clear scam or safety risk must be muted "regardless of the user's usual
 * engagement", so no amount of sender trust is allowed to pull a credential-
 * harvesting message back up to `notify`.
 *
 * Risk is assembled from three independent surfaces, which is what stops a
 * single clever phrasing from evading detection:
 *
 *   - **Content** — multilingual scam lexicons over the fused text/OCR/ASR.
 *   - **Identity** — whether a business sender's domain, verification status,
 *     age and report count hang together.
 *   - **Relationship** — whether this sender has any prior standing with the
 *     user at all, which is what separates a bank alert from a cold approach.
 */

import {
  ACCOUNT_THREAT,
  BANK_DETAIL_REQUEST,
  CHAIN_FORWARD,
  MEDICAL_MISINFO,
  OTP_REQUEST,
  PAYMENT_PRESSURE,
  REWARD_BAIT,
  RISK_LEXICONS,
  SUSPICIOUS_LINK,
  URGENCY_PRESSURE,
  VERIFY_PRESSURE,
  type Lexicon,
} from './lexicons';
import type {
  BusinessAccount,
  Message,
  ResolvedContent,
  RouterContext,
  Signal,
  UserBusinessHistory,
} from './types';

/** Weight each lexicon contributes when it fires. */
const LEXICON_WEIGHT: Record<string, number> = {
  'risk.otp_request': 0.62,
  'risk.bank_detail_request': 0.5,
  'risk.offchannel_payment': 0.4,
  'risk.account_threat': 0.34,
  'risk.verify_pressure': 0.3,
  'risk.payment_pressure': 0.34,
  // "You have been selected" is one of the few phrases that is essentially
  // never benign in this corpus, so it carries near-conclusive weight alone.
  'risk.reward_bait': 0.42,
  'risk.suspicious_link': 0.38,
  'risk.urgency_pressure': 0.14,
  'risk.chain_forward': 0.24,
  'risk.medical_misinfo': 0.3,
};

/** Signals whose combination is characteristic of credential harvesting. */
const CREDENTIAL_HARVEST = new Set([
  'risk.otp_request',
  'risk.bank_detail_request',
]);

export interface RiskAssessment {
  /** 0–1. Values at or above {@link SCAM_THRESHOLD} force a mute. */
  score: number;
  signals: Signal[];
  /** True when the message is confidently fraudulent rather than merely spammy. */
  isScam: boolean;
  /** True when the message is unwanted bulk rather than targeted fraud. */
  isSpam: boolean;
  /** True when the sender tried to steer the router itself. */
  isInjection: boolean;
  /** Codes of every lexicon that fired, for downstream classification. */
  firedCodes: Set<string>;
}

/** At or above this, the engine mutes regardless of every other signal. */
export const SCAM_THRESHOLD = 0.55;

function matches(lexicon: Lexicon, haystack: string): boolean {
  return lexicon.patterns.some((pattern) => pattern.test(haystack));
}

/**
 * Scores how much a business sender's identity fails to hang together.
 *
 * The dataset draws a sharp line: genuine brands send from their official
 * domain, are verified, are years old and attract single-digit reports. Look-
 * alikes ("hdfcbank-kyc.in", 20 days old, 38 reports) fail all four at once.
 * Requiring several failures together, rather than any one, is what keeps a
 * legitimate brand using a marketing subdomain out of the scam bucket.
 */
export function assessBusinessIdentity(
  business: BusinessAccount,
  relationship: UserBusinessHistory | undefined,
): { score: number; signals: Signal[]; impersonation: boolean } {
  const signals: Signal[] = [];
  let score = 0;

  const domainMismatch =
    business.official_domain.length > 0 &&
    business.domain_used_by_sender.length > 0 &&
    business.official_domain !== business.domain_used_by_sender;

  const youngDomain =
    business.domain_used_by_sender_age_days > 0 && business.domain_used_by_sender_age_days < 90;
  const youngAccount = business.account_age_days < 90;
  const heavilyReported = business.user_reports_30d >= 20;

  if (!business.verified) {
    score += 0.12;
    signals.push({
      code: 'risk.business_unverified',
      label: 'Business account is not verified',
      weight: 0.12,
      detail: business.display_name,
    });
  }

  if (domainMismatch) {
    // A mismatch alone is weak — verified brands legitimately use link shorteners
    // and campaign domains. It only becomes damning next to the other failures.
    const weight = business.verified ? 0.08 : 0.3;
    score += weight;
    signals.push({
      code: 'risk.domain_mismatch',
      label: 'Sender domain does not match the official brand domain',
      weight,
      detail: `official ${business.official_domain || 'unknown'} vs sender ${business.domain_used_by_sender}`,
    });
  }

  if (youngDomain) {
    score += 0.22;
    signals.push({
      code: 'risk.young_domain',
      label: 'Sending domain was registered very recently',
      weight: 0.22,
      detail: `${business.domain_used_by_sender_age_days} days old`,
    });
  }

  if (youngAccount) {
    score += 0.12;
    signals.push({
      code: 'risk.young_account',
      label: 'Business account was created very recently',
      weight: 0.12,
      detail: `${business.account_age_days} days old`,
    });
  }

  if (heavilyReported) {
    score += 0.26;
    signals.push({
      code: 'risk.heavily_reported',
      label: 'Many users reported this sender in the last 30 days',
      weight: 0.26,
      detail: `${business.user_reports_30d} reports`,
    });
  }

  // A brand impersonating a bank or wallet is the highest-consequence case.
  const sensitiveCategory = /bank|wallet|payment|sim|telecom|insurance/i.test(business.category);
  if (sensitiveCategory && !business.verified && (domainMismatch || youngDomain)) {
    score += 0.2;
    signals.push({
      code: 'risk.financial_impersonation',
      label: 'Unverified sender impersonating a financial or telecom brand',
      weight: 0.2,
      detail: `${business.display_name} (${business.category})`,
    });
  }

  // A standing relationship is meaningful counter-evidence.
  if (relationship && relationship.activity_count_180d > 0 && business.verified) {
    score -= 0.15;
    signals.push({
      code: 'trust.business_relationship',
      label: 'User has a genuine recent relationship with this business',
      weight: -0.15,
      detail: relationship.why_user_knows_account,
    });
  }

  // Impersonation is a *conjunction*, never a single failure. A verified brand
  // on a campaign domain fails one check and is fine; a lookalike fails the
  // verification check and at least two of {domain mismatch, fresh domain,
  // fresh account, heavily reported} at once. Requiring the conjunction is what
  // keeps real marketing traffic out of the scam bucket.
  const failures = [domainMismatch, youngDomain, youngAccount, heavilyReported].filter(Boolean).length;
  const impersonation = !business.verified && failures >= 2;

  return { score: Math.max(0, score), signals, impersonation };
}

/**
 * Full risk assessment for one message.
 */
export function assessRisk(
  message: Message,
  content: ResolvedContent,
  context: RouterContext,
): RiskAssessment {
  const signals: Signal[] = [];
  const firedCodes = new Set<string>();
  let score = 0;

  // --- 1. Attempts to steer the router ------------------------------------
  // Treated as near-conclusive. Legitimate senders do not address the
  // classifier; only something trying to bypass it has a reason to.
  const isInjection = content.quarantined.length > 0;
  if (isInjection) {
    score += 0.6;
    signals.push({
      code: 'risk.prompt_injection',
      label: 'Message contains instructions aimed at the routing system',
      weight: 0.6,
      detail: content.quarantined.join(' | ').slice(0, 240),
    });
    firedCodes.add('risk.prompt_injection');
  }

  // --- 2. Content lexicons -------------------------------------------------
  for (const lexicon of RISK_LEXICONS) {
    if (!matches(lexicon, content.haystack)) continue;
    const weight = LEXICON_WEIGHT[lexicon.code] ?? 0.2;
    score += weight;
    firedCodes.add(lexicon.code);
    signals.push({ code: lexicon.code, label: lexicon.label, weight });
  }

  // Credential request paired with manufactured pressure is the canonical scam
  // shape. Scoring the combination separately keeps single-signal false
  // positives (a bank legitimately saying "never share your OTP") out.
  const hasCredentialAsk = [...firedCodes].some((code) => CREDENTIAL_HARVEST.has(code));
  const hasPressure =
    firedCodes.has('risk.account_threat') ||
    firedCodes.has('risk.urgency_pressure') ||
    firedCodes.has('risk.verify_pressure');
  if (hasCredentialAsk && hasPressure) {
    score += 0.25;
    signals.push({
      code: 'risk.credential_harvest_pattern',
      label: 'Requests a credential while applying deadline pressure',
      weight: 0.25,
    });
  }

  // A brand that explicitly disclaims OTP requests is doing the opposite of a
  // scam; the lexicons would otherwise read the disclaimer as a hit.
  if (/never ask (for )?(otp|pin|card details|payment details)/i.test(content.haystack)) {
    score -= 0.35;
    signals.push({
      code: 'trust.anti_fraud_advisory',
      label: 'Message is a safety advisory warning against sharing credentials',
      weight: -0.35,
    });
  }
  if (/no payment or otp/i.test(content.haystack)) {
    score -= 0.25;
    signals.push({
      code: 'trust.no_payment_required',
      label: 'Message explicitly states no payment or OTP is needed',
      weight: -0.25,
    });
  }

  // --- 3. Sender identity --------------------------------------------------
  let impersonatesBrand = false;
  if (message.conversation_type === 'business' && message.business_id) {
    const business = context.businesses.get(message.business_id);
    if (business) {
      const relationship = context.userBusiness.get(`${message.user_id}::${message.business_id}`);
      const identity = assessBusinessIdentity(business, relationship);
      score += identity.score;
      signals.push(...identity.signals);
      impersonatesBrand = identity.impersonation;
    }
  }

  // --- 4. Relationship standing -------------------------------------------
  // A first-ever contact asking for money or credentials is the pattern the
  // sample data labels `scam` with no evidence to cite.
  const priorContact = countPriorContact(message, context);
  if (priorContact === 0 && message.conversation_type === 'personal' && hasCredentialAsk) {
    score += 0.3;
    signals.push({
      code: 'risk.first_contact_sensitive_ask',
      label: 'First message from this sender and it asks for sensitive details',
      weight: 0.3,
    });
  }

  // --- 5. Authority to ask for money --------------------------------------
  // In a society or school group, collecting money is an admin function. A
  // non-admin issuing payment instructions in the same channel is either
  // impersonating one or has been compromised — and it is the exact shape of
  // `msg_022` versus the genuine admin notice it copies almost word for word.
  if (message.conversation_type === 'group' && message.group_id && message.sender_user_id) {
    const senderMembership = context.groupMembers.get(
      `${message.group_id}::${message.sender_user_id}`,
    );
    const demandsMoney =
      firedCodes.has('risk.payment_pressure') || firedCodes.has('risk.offchannel_payment');

    if (demandsMoney && senderMembership?.role !== 'admin') {
      score += 0.28;
      signals.push({
        code: 'risk.unauthorised_collection',
        label: 'Non-admin is issuing payment instructions in a group',
        weight: 0.28,
        detail: `sender role: ${senderMembership?.role ?? 'not a member'}`,
      });
    }
  }

  // --- 6. Forward velocity -------------------------------------------------
  if (message.forwarded_count >= 5) {
    const weight = message.forwarded_count >= 9 ? 0.16 : 0.1;
    score += weight;
    signals.push({
      code: 'risk.high_forward_count',
      label: 'Message has been forwarded many times',
      weight,
      detail: `forwarded ${message.forwarded_count} times`,
    });
  }

  score = clamp01(score);

  // --- 6. Classify the flavour of risk ------------------------------------
  // Money or credentials demanded by a sender wearing a brand it cannot prove
  // it owns. The ask alone is ordinary — banks do send payment reminders — and
  // the bad identity alone is ordinary too. Together they are the whole scam.
  const demandsSomething =
    hasCredentialAsk ||
    firedCodes.has('risk.payment_pressure') ||
    firedCodes.has('risk.verify_pressure') ||
    firedCodes.has('risk.account_threat');

  const fraudulent =
    isInjection ||
    hasCredentialAsk ||
    firedCodes.has('risk.reward_bait') ||
    (impersonatesBrand && demandsSomething) ||
    // Classic phishing: threaten the account, then offer the "verification"
    // that resolves the threat. Neither half is conclusive; the pairing is.
    (firedCodes.has('risk.account_threat') && firedCodes.has('risk.verify_pressure')) ||
    (firedCodes.has('risk.payment_pressure') && firedCodes.has('risk.urgency_pressure')) ||
    (firedCodes.has('risk.suspicious_link') &&
      (firedCodes.has('risk.verify_pressure') || firedCodes.has('risk.account_threat'))) ||
    // An ad-hoc payment channel plus any coercive framing. A real admin
    // collecting real dues does not threaten to revoke your access card if the
    // QR is not scanned tonight — the threat is what turns a payment request
    // into extortion, and it is fraud whoever is sending it. Notably this holds
    // even when the sender genuinely *is* an admin, since a compromised or
    // impersonated admin account is the higher-consequence case, not a
    // mitigating one.
    (firedCodes.has('risk.offchannel_payment') &&
      (firedCodes.has('risk.account_threat') ||
        firedCodes.has('risk.urgency_pressure') ||
        firedCodes.has('risk.payment_pressure') ||
        signals.some((signal) => signal.code === 'risk.unauthorised_collection')));

  const bulkNuisance =
    !fraudulent &&
    (firedCodes.has('risk.chain_forward') ||
      firedCodes.has('risk.medical_misinfo') ||
      content.mediaSignals.includes('recorded_telemarketing') ||
      content.mediaSignals.includes('unsolicited_bulk'));

  return {
    score,
    signals,
    isScam: fraudulent && score >= SCAM_THRESHOLD,
    isSpam: bulkNuisance,
    isInjection,
    firedCodes,
  };
}

/** How many historical messages this user received from the same sender. */
export function countPriorContact(message: Message, context: RouterContext): number {
  const history = context.historyByUser.get(message.user_id) ?? [];
  return history.filter((past) => {
    if (message.sender_user_id) return past.sender_user_id === message.sender_user_id;
    if (message.business_id) return past.business_id === message.business_id;
    return false;
  }).length;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Re-exported so tests can assert on individual lexicons. */
export const RISK_LEXICON_INDEX = {
  OTP_REQUEST,
  BANK_DETAIL_REQUEST,
  ACCOUNT_THREAT,
  VERIFY_PRESSURE,
  PAYMENT_PRESSURE,
  REWARD_BAIT,
  SUSPICIOUS_LINK,
  URGENCY_PRESSURE,
  CHAIN_FORWARD,
  MEDICAL_MISINFO,
} as const;
