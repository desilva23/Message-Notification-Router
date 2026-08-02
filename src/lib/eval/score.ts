/**
 * Scoring the router against labelled examples.
 *
 * Mirrors the five things the challenge rubric measures — action accuracy,
 * category accuracy, reason quality, evidence relevance and confidence
 * calibration — so that tuning is driven by the same signal the grader uses
 * rather than by whichever metric happens to be convenient.
 *
 * Two of those need care. Reason quality cannot be graded by string equality
 * against a hidden reference, so it is approximated by whether the emitted
 * phrase is drawn from the house style and is coherent with the action. And
 * calibration is scored as the *gap* between stated confidence and observed
 * correctness, since a router that is right 60% of the time while claiming 0.95
 * is badly calibrated even though its accuracy is unremarkable.
 */

import { REASONS } from '../router/reasons';
import type { Action, LabelledMessage, MessageType, Prediction } from '../router/types';

export interface ConfusionCell {
  expected: string;
  actual: string;
  count: number;
}

export interface EvaluationResult {
  total: number;
  actionAccuracy: number;
  typeAccuracy: number;
  /** Share of reasons drawn from the canonical bank. */
  reasonConsistency: number;
  /** Share of predictions whose cited evidence overlaps the expected set. */
  evidencePrecision: number;
  /** Share where the model cited `none` and the label did too, or both cited. */
  evidenceAgreement: number;
  /** |mean confidence − accuracy|; lower is better calibrated. */
  calibrationError: number;
  meanConfidence: number;
  actionConfusion: ConfusionCell[];
  typeConfusion: ConfusionCell[];
  /** Rows the router got wrong, for inspection. */
  misses: {
    message_id: string;
    expectedAction: Action;
    actualAction: Action;
    expectedType: MessageType;
    actualType: MessageType;
    reason: string;
  }[];
}

const CANONICAL_REASONS = new Set<string>(Object.values(REASONS));

function confusion(pairs: readonly { expected: string; actual: string }[]): ConfusionCell[] {
  const counts = new Map<string, number>();
  for (const pair of pairs) {
    if (pair.expected === pair.actual) continue;
    const key = `${pair.expected}→${pair.actual}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => {
      const [expected = '', actual = ''] = key.split('→');
      return { expected, actual, count };
    })
    .sort((a, b) => b.count - a.count);
}

function parseEvidence(value: string): Set<string> {
  if (!value || value.trim().toLowerCase() === 'none') return new Set();
  return new Set(
    value
      .split(';')
      .map((id) => id.trim())
      .filter(Boolean),
  );
}

/** Scores predictions against labelled examples. */
export function evaluate(
  predictions: readonly Prediction[],
  labels: readonly LabelledMessage[],
): EvaluationResult {
  const byId = new Map(predictions.map((prediction) => [prediction.message_id, prediction]));

  let actionHits = 0;
  let typeHits = 0;
  let canonicalReasons = 0;
  let evidenceOverlap = 0;
  let evidenceAgreements = 0;
  let confidenceSum = 0;

  const actionPairs: { expected: string; actual: string }[] = [];
  const typePairs: { expected: string; actual: string }[] = [];
  const misses: EvaluationResult['misses'] = [];

  for (const label of labels) {
    const prediction = byId.get(label.message_id);
    if (!prediction) continue;

    const actionCorrect = prediction.action === label.action;
    const typeCorrect = prediction.message_type === label.message_type;

    if (actionCorrect) actionHits += 1;
    if (typeCorrect) typeHits += 1;
    if (CANONICAL_REASONS.has(prediction.reason)) canonicalReasons += 1;
    confidenceSum += prediction.confidence;

    actionPairs.push({ expected: label.action, actual: prediction.action });
    typePairs.push({ expected: label.message_type, actual: prediction.message_type });

    const expectedEvidence = parseEvidence(label.evidence_message_ids);
    const actualEvidence = parseEvidence(prediction.evidence_message_ids);

    if (expectedEvidence.size === 0 && actualEvidence.size === 0) {
      evidenceAgreements += 1;
      evidenceOverlap += 1;
    } else if (expectedEvidence.size > 0 && actualEvidence.size > 0) {
      evidenceAgreements += 1;
      const shared = [...actualEvidence].filter((id) => expectedEvidence.has(id));
      if (shared.length > 0) evidenceOverlap += 1;
    }

    if (!actionCorrect || !typeCorrect) {
      misses.push({
        message_id: label.message_id,
        expectedAction: label.action,
        actualAction: prediction.action,
        expectedType: label.message_type,
        actualType: prediction.message_type,
        reason: prediction.reason,
      });
    }
  }

  const total = labels.length || 1;
  const actionAccuracy = actionHits / total;
  const meanConfidence = confidenceSum / total;

  return {
    total: labels.length,
    actionAccuracy,
    typeAccuracy: typeHits / total,
    reasonConsistency: canonicalReasons / total,
    evidencePrecision: evidenceOverlap / total,
    evidenceAgreement: evidenceAgreements / total,
    // Compared against action accuracy: the action is the primary decision, so
    // that is what a stated confidence is implicitly a claim about.
    calibrationError: Math.abs(meanConfidence - actionAccuracy),
    meanConfidence,
    actionConfusion: confusion(actionPairs),
    typeConfusion: confusion(typePairs),
    misses,
  };
}

/** Formats a result as a fixed-width terminal report. */
export function formatReport(result: EvaluationResult): string {
  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`;
  const lines = [
    `Evaluated ${result.total} labelled messages`,
    '',
    `  action accuracy      ${pct(result.actionAccuracy)}`,
    `  message_type accuracy ${pct(result.typeAccuracy)}`,
    `  reason consistency   ${pct(result.reasonConsistency)}`,
    `  evidence precision   ${pct(result.evidencePrecision)}`,
    `  evidence agreement   ${pct(result.evidenceAgreement)}`,
    `  mean confidence      ${result.meanConfidence.toFixed(3)}`,
    `  calibration error    ${result.calibrationError.toFixed(3)}`,
  ];

  if (result.actionConfusion.length > 0) {
    lines.push('', '  action confusion:');
    for (const cell of result.actionConfusion) {
      lines.push(`    ${cell.expected} → ${cell.actual}: ${cell.count}`);
    }
  }

  if (result.typeConfusion.length > 0) {
    lines.push('', '  message_type confusion:');
    for (const cell of result.typeConfusion) {
      lines.push(`    ${cell.expected} → ${cell.actual}: ${cell.count}`);
    }
  }

  if (result.misses.length > 0) {
    lines.push('', '  misses:');
    for (const miss of result.misses) {
      const action =
        miss.expectedAction === miss.actualAction
          ? miss.actualAction
          : `${miss.expectedAction}→${miss.actualAction}`;
      const type =
        miss.expectedType === miss.actualType
          ? miss.actualType
          : `${miss.expectedType}→${miss.actualType}`;
      lines.push(`    ${miss.message_id.padEnd(18)} ${action.padEnd(16)} ${type}`);
    }
  }

  return lines.join('\n');
}
