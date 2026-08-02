/**
 * Historical evidence retrieval and repetition detection.
 *
 * The output contract asks for the historical message ids that support the
 * decision, and the scoring rubric checks that they are *relevant* — so this is
 * not a similarity search with the top hit taken blindly. A candidate earns its
 * place by combining three things:
 *
 *   - **Resemblance** — does it look like the message being routed?
 *   - **Provenance** — is it from the same sender, business or group?
 *   - **Corroboration** — did the user's reaction to it support the decision
 *     being made now? A mute wants the messages the user dismissed; a notify
 *     wants the ones they opened and replied to.
 *
 * Citing a past message the user *replied to* as grounds for muting would be
 * incoherent, so the outcome term is signed by the pending action.
 */

import { jaccard, SimilarityIndex } from './similarity';
import type {
  Action,
  EvidenceItem,
  HistoricalMessage,
  Message,
  MessageEvent,
  ResolvedContent,
  RouterContext,
  Signal,
} from './types';

/**
 * Cosine at or above this means "the user has effectively seen this already".
 *
 * Tuned low deliberately. The repeats in this corpus are re-phrasings rather
 * than copies — the same seller posts the same kurta four times with different
 * wording — and a strict threshold recovers only the verbatim resend, which
 * makes a browsing user and a fed-up user look identical. Precision is
 * recovered downstream by weighing the *balance* of reactions rather than by
 * demanding near-identity here.
 */
const NEAR_DUPLICATE_THRESHOLD = 0.45;

/** Jaccard at or above this means a near-verbatim resend. */
const VERBATIM_THRESHOLD = 0.7;

export interface RepetitionAssessment {
  /** Negative; how much repetition should suppress this message. */
  score: number;
  signals: Signal[];
  /** Historical ids that are near-duplicates of this message. */
  duplicateIds: string[];
  /** How many of those the user dismissed, muted or ignored. */
  ignoredCount: number;
  /** How many of those the user opened or replied to. */
  engagedCount: number;
}

function outcomeOf(event: MessageEvent | undefined): EvidenceItem['outcome'] {
  if (!event) return 'ignored';
  if (event.message_reported === 1) return 'reported';
  if (event.muted_after_message === 1) return 'muted';
  if (event.message_replied === 1) return 'replied';
  if (event.notification_dismissed === 1) return 'dismissed';
  if (event.message_opened === 1) return 'opened';
  return 'ignored';
}

/** True when the user's reaction shows the message was unwelcome. */
function isNegativeOutcome(outcome: EvidenceItem['outcome']): boolean {
  return outcome === 'dismissed' || outcome === 'muted' || outcome === 'reported' || outcome === 'ignored';
}

/** True when the user's reaction shows the message mattered to them. */
function isPositiveOutcome(outcome: EvidenceItem['outcome']): boolean {
  return outcome === 'opened' || outcome === 'replied';
}

/**
 * Text used for matching a historical message, fused across modalities.
 *
 * Mirrors `ResolvedContent.authored` — sender-written words only, no scene
 * description — so both sides of every comparison are drawn from the same
 * vocabulary.
 */
function historicalText(past: HistoricalMessage, context: RouterContext): string {
  const parts = [past.message_text ?? ''];
  if (past.media_type === 'image' && past.media_id) {
    const image = context.media.images[past.media_id];
    if (image) parts.push(image.ocr_text);
  }
  if (past.media_type === 'voice' && past.media_id) {
    const voice = context.media.voice_notes[past.media_id];
    if (voice) parts.push(voice.transcript);
  }
  return parts.filter(Boolean).join(' ');
}

/** True when a historical message came from the same place as the new one. */
function sharesProvenance(message: Message, past: HistoricalMessage): boolean {
  if (message.sender_user_id && past.sender_user_id === message.sender_user_id) return true;
  if (message.business_id && past.business_id === message.business_id) return true;
  if (message.group_id && past.group_id === message.group_id) return true;
  return false;
}

/**
 * Detects that the user has seen this content before and how they reacted.
 *
 * This is what separates the two `img_008` rows in the sample data: identical
 * resale posters, one user who engages with the marketplace group and one who
 * has dismissed everything like it.
 */
export function assessRepetition(
  message: Message,
  content: ResolvedContent,
  context: RouterContext,
  index: SimilarityIndex,
): RepetitionAssessment {
  const history = context.historyByUser.get(message.user_id) ?? [];
  if (history.length === 0) {
    return { score: 0, signals: [], duplicateIds: [], ignoredCount: 0, engagedCount: 0 };
  }

  const candidates = new Set(history.map((past) => past.message_id));
  const query = content.authored;
  const hits = index.query(query, { candidates, limit: 12 });

  const duplicateIds: string[] = [];
  let ignoredCount = 0;
  let engagedCount = 0;
  let reportedCount = 0;
  let mutedCount = 0;

  for (const hit of hits) {
    const past = context.history.get(hit.id);
    if (!past) continue;

    const verbatim = jaccard(query, historicalText(past, context)) >= VERBATIM_THRESHOLD;
    if (hit.score < NEAR_DUPLICATE_THRESHOLD && !verbatim) continue;

    duplicateIds.push(hit.id);
    const outcome = outcomeOf(context.events.get(`${message.user_id}::${hit.id}`));
    if (isNegativeOutcome(outcome)) ignoredCount += 1;
    if (isPositiveOutcome(outcome)) engagedCount += 1;
    if (outcome === 'reported') reportedCount += 1;
    if (outcome === 'muted') mutedCount += 1;
  }

  const signals: Signal[] = [];
  let score = 0;

  // What matters is the *balance*, not the raw count of dismissals. Someone who
  // opened nine marketplace listings and dismissed two is browsing normally;
  // someone who dismissed all four is telling us to stop. Counting only the
  // negatives would mute both of them identically.
  const net = ignoredCount - engagedCount;

  if (net >= 2) {
    score -= 0.34;
    signals.push({
      code: 'fatigue.repeated_and_ignored',
      label: 'User has ignored or dismissed several near-identical messages',
      weight: -0.34,
      detail: `${ignoredCount} ignored vs ${engagedCount} engaged`,
    });
  } else if (net === 1) {
    score -= 0.18;
    signals.push({
      code: 'fatigue.repeated_and_ignored',
      label: 'User previously ignored a near-identical message',
      weight: -0.18,
      detail: `${ignoredCount} ignored vs ${engagedCount} engaged`,
    });
  } else if (engagedCount >= 2) {
    score += 0.1;
    signals.push({
      code: 'context.engaged_with_similar',
      label: 'User has engaged with similar messages before',
      weight: 0.1,
      detail: `${engagedCount} of ${duplicateIds.length} similar messages engaged with`,
    });
  } else if (duplicateIds.length > 0) {
    score += 0.06;
    signals.push({
      code: 'context.seen_similar',
      label: 'User has seen similar messages before',
      weight: 0.06,
      detail: `${duplicateIds.length} similar messages`,
    });
  }

  if (reportedCount > 0) {
    score -= 0.3;
    signals.push({
      code: 'risk.previously_reported',
      label: 'User reported a near-identical message before',
      weight: -0.3,
      detail: `${reportedCount} reported`,
    });
  }

  // Muting after a message is an explicit instruction, not a passive signal
  // like leaving something unopened. It deserves its own weight — the user
  // already told us once what they want to happen to content like this.
  if (mutedCount > 0 && engagedCount === 0) {
    score -= 0.24;
    signals.push({
      code: 'fatigue.muted_after_similar',
      label: 'User muted the conversation after a near-identical message',
      weight: -0.24,
      detail: `${mutedCount} muted`,
    });
  }

  return { score, signals, duplicateIds, ignoredCount, engagedCount };
}

/**
 * Selects the historical messages to cite for a decision.
 *
 * @param action  the decision being justified; steers which reactions count as
 *                corroborating rather than contradicting
 * @param limit   the sample data cites one id normally and two when the point
 *                being made is a repeating pattern
 */
export function selectEvidence(
  message: Message,
  content: ResolvedContent,
  context: RouterContext,
  index: SimilarityIndex,
  action: Action,
  limit = 1,
): EvidenceItem[] {
  const history = context.historyByUser.get(message.user_id) ?? [];
  if (history.length === 0) return [];

  const candidates = new Set(history.map((past) => past.message_id));
  const query = content.authored;
  const hits = index.query(query, { candidates, limit: 25 });

  const scored: EvidenceItem[] = [];

  for (const hit of hits) {
    const past = context.history.get(hit.id);
    if (!past) continue;

    const outcome = outcomeOf(context.events.get(`${message.user_id}::${hit.id}`));

    // Resemblance dominates; provenance and corroboration break ties.
    let score = hit.score * 0.6;

    // Provenance carries more weight for business and voice-note traffic, where
    // wording varies wildly between sends but "this is the same sender doing
    // the same thing again" is exactly the point being evidenced. A recorded
    // sales call and a loan-approval text share almost no vocabulary yet are
    // the same nuisance from the user's side.
    if (sharesProvenance(message, past)) {
      score += message.conversation_type === 'business' || message.media_type === 'voice' ? 0.32 : 0.22;
    }

    if (action === 'mute') {
      if (isNegativeOutcome(outcome)) score += 0.18;
      if (outcome === 'reported') score += 0.08;
      if (isPositiveOutcome(outcome)) score -= 0.12;
    } else if (action === 'notify') {
      if (isPositiveOutcome(outcome)) score += 0.18;
      if (outcome === 'replied') score += 0.06;
      if (isNegativeOutcome(outcome)) score -= 0.1;
    } else {
      // `digest` is the neutral case: any engagement at all is corroborating,
      // since the point being made is "relevant but not urgent".
      if (isPositiveOutcome(outcome)) score += 0.08;
    }

    // Same modality is weak corroboration that the comparison is like-for-like.
    if (past.media_type === message.media_type && message.media_type !== '') score += 0.05;

    scored.push({ message_id: hit.id, score, reason: describeOutcome(outcome), outcome });
  }

  scored.sort((a, b) => b.score - a.score || a.message_id.localeCompare(b.message_id));

  // A weak best hit is worse than citing nothing: the rubric rewards relevance,
  // and the sample data uses `none` when the sender is genuinely new.
  const MINIMUM_RELEVANCE = 0.22;
  const selected = scored.filter((item) => item.score >= MINIMUM_RELEVANCE).slice(0, limit);
  if (selected.length > 0) return selected;

  // Lexical retrieval can only surface documents that share a word with the
  // query, so a recorded sales call and a loan-offer text from the same sender
  // never meet — despite being the same nuisance from the user's side, which is
  // precisely the point the evidence needs to make. Falling back to provenance
  // recovers those, and only those: the claim becomes "same sender, same
  // reaction" rather than "same words".
  return provenanceFallback(message, context, action, limit);
}

/** Cites same-sender history whose outcome corroborates the decision. */
function provenanceFallback(
  message: Message,
  context: RouterContext,
  action: Action,
  limit: number,
): EvidenceItem[] {
  const history = context.historyByUser.get(message.user_id) ?? [];

  const wanted = history
    .filter((past) => sharesProvenance(message, past))
    .map((past) => ({
      past,
      outcome: outcomeOf(context.events.get(`${message.user_id}::${past.message_id}`)),
    }))
    .filter(({ outcome }) =>
      action === 'mute' ? isNegativeOutcome(outcome) : isPositiveOutcome(outcome),
    );

  // `historyByUser` is already newest-first, so the most recent corroborating
  // interaction is the most persuasive one to cite.
  return wanted.slice(0, limit).map(({ past, outcome }) => ({
    message_id: past.message_id,
    score: 0.25,
    reason: describeOutcome(outcome),
    outcome,
  }));
}

function describeOutcome(outcome: EvidenceItem['outcome']): string {
  switch (outcome) {
    case 'replied':
      return 'User replied to this earlier message';
    case 'opened':
      return 'User opened this earlier message';
    case 'dismissed':
      return 'User dismissed the notification for this earlier message';
    case 'muted':
      return 'User muted the conversation after this earlier message';
    case 'reported':
      return 'User reported this earlier message';
    default:
      return 'User did not engage with this earlier message';
  }
}

/** Formats evidence for the CSV column, using `none` when empty. */
export function formatEvidence(items: readonly EvidenceItem[]): string {
  if (items.length === 0) return 'none';
  return items.map((item) => item.message_id).join(';');
}
