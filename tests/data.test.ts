/**
 * Data-layer tests: Supabase configuration gating and the evaluation harness.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { evaluate, formatReport } from '../src/lib/eval/score';
import { getServiceClient, isSupabaseConfigured } from '../src/lib/data/supabase';
import { mirrorStatus } from '../src/lib/data/repository';
import { loadMediaPaths } from '../src/lib/data/load';
import { REASONS } from '../src/lib/router/reasons';
import type { LabelledMessage, Prediction } from '../src/lib/router/types';
import { makeMessage } from './helpers';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('Supabase configuration', () => {
  it('reports unconfigured when the variables are absent', () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    expect(isSupabaseConfigured()).toBe(false);
  });

  it('reports unconfigured when a variable is blank', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = '   ';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon';
    expect(isSupabaseConfigured()).toBe(false);
  });

  it('reports configured when both are present', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'anon-key';
    expect(isSupabaseConfigured()).toBe(true);
  });

  it('refuses to build a service client without the service key', () => {
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://example.supabase.co';
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    expect(() => getServiceClient()).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });
});

describe('media path loading', () => {
  it('maps every media id to a file path', () => {
    const { images, voiceNotes } = loadMediaPaths();
    expect(Object.keys(images).length).toBeGreaterThan(0);
    expect(Object.keys(voiceNotes).length).toBeGreaterThan(0);
    expect(images.img_002).toMatch(/media\/images\//);
    expect(voiceNotes.vn_001).toMatch(/media\/audio\//);
  });
});

describe('evaluation harness', () => {
  const label = (overrides: Partial<LabelledMessage>): LabelledMessage => ({
    ...makeMessage({ message_id: 'm1' }),
    action: 'notify',
    message_type: 'urgent',
    reason: REASONS.DIRECT_ASK,
    confidence: 0.87,
    evidence_message_ids: 'h1',
    ...overrides,
  });

  const prediction = (overrides: Partial<Prediction>): Prediction => ({
    message_id: 'm1',
    action: 'notify',
    message_type: 'urgent',
    reason: REASONS.DIRECT_ASK,
    confidence: 0.87,
    evidence_message_ids: 'h1',
    ...overrides,
  });

  it('scores a perfect match', () => {
    const result = evaluate([prediction({})], [label({})]);
    expect(result.actionAccuracy).toBe(1);
    expect(result.typeAccuracy).toBe(1);
    expect(result.reasonConsistency).toBe(1);
    expect(result.evidencePrecision).toBe(1);
  });

  it('records a confusion cell for a wrong action', () => {
    const result = evaluate([prediction({ action: 'digest' })], [label({})]);
    expect(result.actionAccuracy).toBe(0);
    expect(result.actionConfusion).toContainEqual({ expected: 'notify', actual: 'digest', count: 1 });
    expect(result.misses).toHaveLength(1);
  });

  it('counts agreement when both sides cite nothing', () => {
    const result = evaluate(
      [prediction({ evidence_message_ids: 'none' })],
      [label({ evidence_message_ids: 'none' })],
    );
    expect(result.evidenceAgreement).toBe(1);
    expect(result.evidencePrecision).toBe(1);
  });

  it('counts disagreement when only one side cites evidence', () => {
    const result = evaluate(
      [prediction({ evidence_message_ids: 'none' })],
      [label({ evidence_message_ids: 'h1' })],
    );
    expect(result.evidenceAgreement).toBe(0);
  });

  it('credits partial overlap in a multi-id citation', () => {
    const result = evaluate(
      [prediction({ evidence_message_ids: 'h1;h9' })],
      [label({ evidence_message_ids: 'h1;h2' })],
    );
    expect(result.evidencePrecision).toBe(1);
  });

  it('flags an off-bank reason as inconsistent', () => {
    const result = evaluate([prediction({ reason: 'made up on the spot' })], [label({})]);
    expect(result.reasonConsistency).toBe(0);
  });

  it('measures calibration as the gap between confidence and accuracy', () => {
    const result = evaluate([prediction({ action: 'digest', confidence: 0.9 })], [label({})]);
    expect(result.calibrationError).toBeCloseTo(0.9);
  });

  it('ignores labels with no matching prediction', () => {
    const result = evaluate([], [label({})]);
    expect(result.total).toBe(1);
    expect(result.actionAccuracy).toBe(0);
  });

  it('renders a readable report', () => {
    const report = formatReport(evaluate([prediction({ action: 'mute' })], [label({})]));
    expect(report).toContain('action accuracy');
    expect(report).toContain('notify → mute');
  });
});

describe('supabase mirror status', () => {
  // The mirror is a liveness indicator, not a data source: rendering always
  // reads the bundled snapshot. These assert the reported status cannot imply
  // otherwise — two of the three branches need credentials and a network round
  // trip to reach in situ, so they would otherwise ship unverified.

  it('reports not-configured when no credentials are present', () => {
    expect(mirrorStatus(false, false)).toBe('not-configured');
  });

  it('stays not-configured even if a probe somehow succeeded', () => {
    expect(mirrorStatus(false, true)).toBe('not-configured');
  });

  it('reports live when configured and the probe answered', () => {
    expect(mirrorStatus(true, true)).toBe('live');
  });

  it('reports unreachable when configured but the probe failed', () => {
    expect(mirrorStatus(true, false)).toBe('unreachable');
  });
});
