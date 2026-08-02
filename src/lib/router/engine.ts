/**
 * The routing engine.
 *
 * Orchestrates the scorers into a single decision. The flow is:
 *
 *   resolve content  →  assess risk  →  assess trust  →  assess repetition
 *                    →  classify     →  score actions →  apply safety overrides
 *                    →  select evidence  →  pick reason  →  calibrate confidence
 *
 * Two design choices are load-bearing.
 *
 * **Safety is an override, not a vote.** The scores decide between `notify`,
 * `digest` and `mute` for ordinary traffic, but a confirmed credential-
 * harvesting attempt short-circuits them entirely. The specification requires
 * that clear risk be muted regardless of the user's engagement, and a purely
 * additive model cannot promise that — enough trust would eventually outvote it.
 *
 * **Every number is attributable.** Each scorer returns named signals rather
 * than an opaque delta, so the final score is the sum of a list a human can
 * read. That is what the explainability panel renders, and it is why a wrong
 * prediction can be diagnosed instead of merely re-tuned.
 *
 * The function is pure: same inputs, same output, no I/O.
 */

import { classify } from './classify';
import { calibrateConfidence } from './confidence';
import { resolveContent } from './content';
import { formatEvidence, assessRepetition, selectEvidence } from './evidence';
import { assessIntent } from './intent';
import { selectReason } from './reasons';
import { assessRisk, SCAM_THRESHOLD, type RiskAssessment } from './risk';
import { SimilarityIndex } from './similarity';
import { assessTrust, type TrustAssessment } from './trust';
import type {
  Action,
  Message,
  MessageType,
  RouterContext,
  RoutingDecision,
  Signal,
} from './types';

/** Baseline score for each action before any signal is applied. */
const BASE_SCORES: Record<Action, number> = {
  notify: 0.0,
  digest: 0.34,
  mute: 0.0,
};

/** Categories that are never worth an interruption on their own. */
const NEVER_INTERRUPT: ReadonlySet<MessageType> = new Set([
  'promotion',
  'greeting',
  'forward',
  'spam',
]);

/**
 * Builds the similarity index over the historical corpus.
 *
 * Hoisted out of {@link routeMessage} so a batch run pays for it once rather
 * than once per message.
 */
export function buildSimilarityIndex(context: RouterContext): SimilarityIndex {
  const documents: { id: string; text: string }[] = [];
  for (const [id, past] of context.history) {
    // Sender-authored text only, matching `ResolvedContent.authored`. Indexing
    // the model's scene descriptions would introduce vocabulary that appears on
    // one side of a comparison and never the other.
    const parts = [past.message_text ?? ''];
    if (past.media_type === 'image' && past.media_id) {
      const image = context.media.images[past.media_id];
      if (image) parts.push(image.ocr_text);
    }
    if (past.media_type === 'voice' && past.media_id) {
      const voice = context.media.voice_notes[past.media_id];
      if (voice) parts.push(voice.transcript);
    }
    documents.push({ id, text: parts.filter(Boolean).join(' ') });
  }
  return new SimilarityIndex(documents);
}

/** Routes a single message. Pure — safe to call concurrently. */
export function routeMessage(
  message: Message,
  context: RouterContext,
  index: SimilarityIndex,
): RoutingDecision {
  const content = resolveContent(message, context.media);
  const risk = assessRisk(message, content, context);
  const trust = assessTrust(message, content, context);
  const intent = assessIntent(content);
  const repetition = assessRepetition(message, content, context, index);
  const classification = classify(message, content, risk, trust, context);

  // Reconcile channel-level averages against content-level evidence. Reading
  // 1 of 963 messages in a 241-member marketplace makes a user look
  // disengaged, but if they opened four of the last five listings like this
  // one, the average is describing the group's volume rather than this user's
  // interest — and the specific observation is the better evidence. Without
  // this, anyone in a busy group is permanently penalised for its size.
  const hasTopicEngagement = repetition.signals.some(
    (signal) => signal.code === 'context.engaged_with_similar',
  );
  const supersededCodes = hasTopicEngagement
    ? new Set(['fatigue.low_read_rate', 'trust.broadcast_group'])
    : new Set<string>();

  const trustSignals = trust.signals.filter((signal) => !supersededCodes.has(signal.code));
  const supersededWeight = trust.signals
    .filter((signal) => supersededCodes.has(signal.code))
    .reduce((sum, signal) => sum + signal.weight, 0);

  // A raw forward count is a proxy for "circulated junk", and a poor one in a
  // group that exists to circulate things. A market note in a stock-watch group
  // is forwarded because that is the group's purpose, and the user opened the
  // last one. When there is direct evidence of engagement and the message is
  // not an actual chain letter, the proxy is superseded by the observation.
  const waiveForwardPenalty =
    repetition.engagedCount > 0 &&
    repetition.ignoredCount === 0 &&
    !risk.firedCodes.has('risk.chain_forward') &&
    !risk.isScam;

  const riskSignals = waiveForwardPenalty
    ? risk.signals.filter((signal) => signal.code !== 'risk.high_forward_count')
    : risk.signals;

  const waivedRiskWeight = waiveForwardPenalty
    ? risk.signals
        .filter((signal) => signal.code === 'risk.high_forward_count')
        .reduce((sum, signal) => sum + signal.weight, 0)
    : 0;

  const signals: Signal[] = [
    ...riskSignals,
    ...trustSignals,
    ...intent.signals,
    ...repetition.signals,
  ];

  // --- Score the three actions --------------------------------------------

  const scores: Record<Action, number> = { ...BASE_SCORES };

  // Trust and repetition move the message along the notify↔mute axis. Intent
  // only ever contributes its positive part here: "no rush" means the message
  // is not urgent, which is an argument for `digest`, not for suppressing it.
  // Letting it subtract would turn every polite sender into a muted one.
  const attention =
    trust.score - supersededWeight + repetition.score + Math.max(0, intent.score);

  // For a business sender, a good relationship establishes that the message is
  // *legitimate*, not that it is *urgent*. A verified brand the user shops with
  // every week still has no claim on being interrupted for a feedback survey.
  // So positive standing argues against muting rather than for notifying,
  // unless the message is actually anchored to something imminent.
  // An `event` is exempt: an appointment or booking reminder is a commitment
  // the user has to be ready for, which is exactly what an interruption is for.
  const businessLegitimacyOnly =
    message.conversation_type === 'business' &&
    !intent.isUrgent &&
    !intent.isTimeAnchored &&
    classification.type !== 'event';

  if (businessLegitimacyOnly) {
    scores.digest += Math.max(0, attention);
  } else {
    scores.notify += Math.max(0, attention);
  }
  scores.mute += Math.max(0, -attention);

  if (intent.isDeferrable) scores.digest += 0.22;

  // Risk only ever pushes towards mute.
  scores.mute += Math.max(0, risk.score - waivedRiskWeight);

  // Category priors. `urgent` exists to be interrupted by; `promotion` and
  // `greeting` almost never justify one.
  switch (classification.type) {
    case 'urgent':
      scores.notify += 0.4;
      break;
    case 'event':
      scores.notify += 0.16;
      scores.digest += 0.1;
      break;
    case 'payment':
      scores.notify += 0.14;
      scores.digest += 0.08;
      break;
    case 'business_update':
      scores.digest += 0.14;
      break;
    case 'promotion':
      scores.digest += 0.12;
      scores.mute += 0.14;
      break;
    case 'greeting':
      scores.digest += 0.1;
      scores.mute += 0.16;
      break;
    case 'forward':
      scores.mute += 0.3;
      break;
    case 'spam':
      scores.mute += 0.45;
      break;
    case 'scam':
      scores.mute += 0.8;
      break;
    default:
      scores.digest += 0.06;
  }

  // Content asking this user for something specific earns an interruption in a
  // way that broadcast content does not.
  if (earnsMentionExemption(trust, risk)) {
    scores.notify += 0.12;

    // Named person + explicit ask is the clearest interruption case there is,
    // and it survives softening language. "@u_004 when you get 5 mins can you
    // call?" is still a request aimed at one human, and deferring it means the
    // person waiting for the answer keeps waiting.
    if (intent.requestsResponse) scores.notify += 0.2;
  }

  let action = argmax(scores);
  let override: string | undefined;

  // --- Hard safety overrides ----------------------------------------------

  if (risk.isScam || risk.score >= SCAM_THRESHOLD) {
    action = 'mute';
    override = risk.isInjection
      ? 'Message attempted to instruct the router; decided on content and risk instead'
      : 'Confirmed safety risk overrides engagement signals';
  } else if (risk.isSpam && action === 'notify') {
    // Bulk nuisance never warrants an interruption, however trusted the channel.
    action = 'digest';
    override = 'Bulk or unsolicited content downgraded from an interruption';
  } else if (NEVER_INTERRUPT.has(classification.type) && action === 'notify' && !earnsMentionExemption(trust, risk)) {
    // Advertising, well-wishing and chain forwards do not earn an interruption
    // no matter how engaged the user is with the channel carrying them. A
    // direct mention is the one exception — that is a person, not a broadcast.
    action = 'digest';
    override = 'Category never justifies an interruption without a direct mention';
  }

  // A muted group still lets a direct, non-risky mention through — the
  // specification calls this case out explicitly.
  if (trust.groupMuted && earnsMentionExemption(trust, risk) && action === 'mute') {
    action = 'notify';
    override = 'Direct mention overrides the user’s group mute';
  }

  const margin = computeMargin(scores, action, Boolean(override));

  // --- Evidence, reason, confidence ---------------------------------------

  // A repetition-driven mute is making a claim about a *pattern*, so it cites
  // the two strongest prior instances; every other case cites one.
  const evidenceLimit = action === 'mute' && repetition.ignoredCount >= 2 ? 2 : 1;

  // When the decision rests on the *absence* of any prior relationship, citing
  // history would contradict the reason being given. "This is the first message
  // from this sender" and "here is a past message from them" cannot both hold,
  // so these cases correctly report `none`.
  const restsOnAbsence = risk.signals.some(
    (signal) => signal.code === 'risk.first_contact_sensitive_ask',
  );

  const evidence = restsOnAbsence
    ? []
    : selectEvidence(message, content, context, index, action, evidenceLimit);

  const group = message.group_id ? context.groups.get(message.group_id) : undefined;
  const business = message.business_id ? context.businesses.get(message.business_id) : undefined;
  const relationship = message.business_id
    ? context.userBusiness.get(`${message.user_id}::${message.business_id}`)
    : undefined;

  const reason = selectReason({
    action,
    type: classification.type,
    signals,
    groupType: group?.group_type,
    senderIsAdmin: trust.senderIsAdmin,
    hasBusinessRelationship: Boolean(relationship && relationship.activity_count_180d > 0),
    businessVerified: business?.verified === 1,
    evidenceIsPositive: evidence.some(
      (item) => item.outcome === 'opened' || item.outcome === 'replied',
    ),
  });

  const confidence = calibrateConfidence({
    action,
    margin,
    hardOverride: Boolean(override) && action === 'mute',
    evidenceCount: evidence.length,
    mediaDerived: message.media_type !== '' && content.text.length < 40,
  });

  return {
    prediction: {
      message_id: message.message_id,
      action,
      message_type: classification.type,
      reason,
      confidence,
      evidence_message_ids: formatEvidence(evidence),
    },
    content,
    signals,
    scores,
    margin,
    evidence,
    override,
  };
}

/** Routes an entire batch, building the shared index once. */
export function routeAll(
  messages: readonly Message[],
  context: RouterContext,
): RoutingDecision[] {
  const index = buildSimilarityIndex(context);
  return messages.map((message) => routeMessage(message, context, index));
}

/**
 * Whether a direct mention should be allowed to bypass a suppression rule.
 *
 * The exemption exists because a real person naming this user in a muted group
 * deserves to get through. A chain letter that opens "@u_007 forward this to
 * ten people for blessings" is not that — it templates the mention precisely to
 * buy the credibility of one, and honouring it would turn the exemption into
 * the easiest bypass in the system. So the mention only counts when the message
 * is not itself the kind of thing being suppressed.
 */
function earnsMentionExemption(trust: TrustAssessment, risk: RiskAssessment): boolean {
  if (!trust.directlyAddressed) return false;
  if (risk.isScam || risk.isSpam) return false;
  if (risk.firedCodes.has('risk.chain_forward')) return false;
  return true;
}

function argmax(scores: Record<Action, number>): Action {
  let best: Action = 'digest';
  let bestScore = -Infinity;
  // Iterated in a fixed order so ties resolve identically on every run.
  for (const action of ['notify', 'digest', 'mute'] as const) {
    if (scores[action] > bestScore) {
      best = action;
      bestScore = scores[action];
    }
  }
  return best;
}

/**
 * Gap between the chosen action and the best alternative.
 *
 * When a hard override moved the decision, the score gap no longer describes
 * how the choice was made, so the margin is reported as decisive.
 */
function computeMargin(scores: Record<Action, number>, chosen: Action, overridden: boolean): number {
  if (overridden) return 1;
  const others = (['notify', 'digest', 'mute'] as const)
    .filter((action) => action !== chosen)
    .map((action) => scores[action]);
  return scores[chosen] - Math.max(...others);
}
