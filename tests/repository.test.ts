/**
 * The web app's single entry point.
 *
 * Every page renders from `getRoutingSnapshot()`, and until now nothing
 * exercised it — the module was invisible to coverage because no test imported
 * it. These assert the two properties the deployment actually depends on: that
 * it produces a complete routed snapshot, and that it does so without a network
 * round trip when no credentials are present, which is the case a reviewer
 * cloning the repo hits.
 *
 * Kept in its own file so the module-level cache and the Supabase environment
 * cannot be disturbed by other suites.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { getDecision, getRoutingSnapshot, mirrorStatus } from '../src/lib/data/repository';
import { ACTIONS, MESSAGE_TYPES } from '../src/lib/router/types';

const SUPABASE_VARS = [
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
] as const;

const saved: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of SUPABASE_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterAll(() => {
  for (const key of SUPABASE_VARS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe('getRoutingSnapshot', () => {
  it('renders a complete snapshot without any network call', async () => {
    // The submission contract is that a reviewer with no credentials can run
    // this. A stray fetch would mean the deployed page depends on a service
    // being up, which is exactly what the CSV path exists to avoid.
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const snapshot = await getRoutingSnapshot();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(snapshot.mirror).toBe('not-configured');
    expect(snapshot.messages).toHaveLength(110);
    expect(snapshot.decisions).toHaveLength(110);

    fetchSpy.mockRestore();
  });

  it('pairs every message with a decision carrying a valid prediction', async () => {
    const snapshot = await getRoutingSnapshot();

    snapshot.decisions.forEach((decision, index) => {
      const message = snapshot.messages[index];
      expect(decision.prediction.message_id).toBe(message?.message_id);
      expect(ACTIONS).toContain(decision.prediction.action);
      expect(MESSAGE_TYPES).toContain(decision.prediction.message_type);
      expect(decision.prediction.reason.length).toBeGreaterThan(0);
    });
  });

  it('reuses the cached snapshot rather than re-routing per request', async () => {
    // Routing is deterministic over a static dataset, so recomputing per request
    // would burn CPU to produce a byte-identical answer.
    const first = await getRoutingSnapshot();
    const second = await getRoutingSnapshot();
    expect(second).toBe(first);
  });

  it('carries an evaluation of the labelled samples', async () => {
    const snapshot = await getRoutingSnapshot();
    expect(snapshot.evaluation.total).toBeGreaterThan(0);
    expect(snapshot.evaluation.actionAccuracy).toBeGreaterThan(0.9);
  });

  it('resolves a known message id and rejects an unknown one', async () => {
    const found = await getDecision('msg_023');
    expect(found?.message.message_id).toBe('msg_023');
    expect(found?.decision.prediction.message_id).toBe('msg_023');

    expect(await getDecision('msg_does_not_exist')).toBeUndefined();
  });
});

describe('mirrorStatus', () => {
  it('never reports a mirror as live without configuration', () => {
    expect(mirrorStatus(false, true)).toBe('not-configured');
  });
});
