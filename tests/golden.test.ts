/**
 * Golden tests against the 30 solved examples.
 *
 * These are the regression net for accuracy. The thresholds are floors, not
 * targets: they are set at the level the engine currently reaches so that any
 * future change which trades away accuracy fails loudly instead of silently.
 *
 * The labelled rows are routed through the production pipeline unchanged — same
 * loader, same context, same engine — so what is measured is the shipped system
 * rather than a test-only reimplementation of it.
 */

import { describe, expect, it } from 'vitest';
import { evaluate } from '../src/lib/eval/score';
import { routeAll } from '../src/lib/router/engine';
import { realContext, realSamples } from './helpers';

const context = realContext();
const samples = realSamples();
const decisions = routeAll(samples, context);
const predictions = decisions.map((decision) => decision.prediction);
const result = evaluate(predictions, samples);

describe('accuracy on labelled examples', () => {
  it('classifies every action correctly', () => {
    expect(result.actionAccuracy).toBe(1);
  });

  it('classifies every message type correctly', () => {
    expect(result.typeAccuracy).toBe(1);
  });

  it('draws every reason from the canonical bank', () => {
    expect(result.reasonConsistency).toBe(1);
  });

  it('agrees with the label on whether evidence exists at all', () => {
    expect(result.evidenceAgreement).toBeGreaterThanOrEqual(0.9);
  });

  it('stays close to the labelled confidence distribution', () => {
    // The labelled mean is 0.836; drifting far from it in either direction
    // means the router is systematically over- or under-claiming.
    expect(result.meanConfidence).toBeGreaterThan(0.8);
    expect(result.meanConfidence).toBeLessThan(0.88);
  });
});

describe('personalisation', () => {
  it('routes the same content differently for two different users', () => {
    // sample_msg_044 and sample_msg_045 are the same resale poster sent to a
    // user who engages with the marketplace and one who has dismissed
    // everything like it. If these ever agree, personalisation has stopped
    // working — which no aggregate accuracy number would reveal.
    const byId = new Map(predictions.map((prediction) => [prediction.message_id, prediction]));
    const engaged = byId.get('sample_msg_044');
    const fatigued = byId.get('sample_msg_045');

    expect(engaged?.message_type).toBe(fatigued?.message_type);
    expect(engaged?.action).not.toBe(fatigued?.action);
  });
});

describe('per-case expectations', () => {
  const byId = new Map(predictions.map((prediction) => [prediction.message_id, prediction]));

  const cases: [string, string, string][] = [
    ['sample_msg_001', 'notify', 'urgent'],
    ['sample_msg_002', 'notify', 'event'],
    ['sample_msg_004', 'notify', 'business_update'],
    ['sample_msg_009', 'digest', 'greeting'],
    ['sample_msg_013', 'mute', 'greeting'],
    ['sample_msg_014', 'mute', 'forward'],
    ['sample_msg_019', 'mute', 'scam'],
    ['sample_msg_050', 'digest', 'personal'],
    ['sample_msg_051', 'notify', 'urgent'],
    ['sample_msg_052', 'mute', 'scam'],
    ['sample_msg_053', 'mute', 'scam'],
  ];

  it.each(cases)('%s routes to %s/%s', (id, action, type) => {
    const prediction = byId.get(id);
    expect(prediction?.action).toBe(action);
    expect(prediction?.message_type).toBe(type);
  });
});
