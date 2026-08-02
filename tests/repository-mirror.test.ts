/**
 * The Supabase-configured branch of the snapshot.
 *
 * Reaching this in situ needs live credentials, so it went untested. Mocking the
 * probe alone would mostly test the mock — but the property worth locking down
 * is not what the probe returns, it is what the rest of the snapshot does when
 * the probe succeeds: nothing. Supabase is a mirror, and a live mirror must not
 * change a single routed decision. That invariant is the reason the field is
 * named `mirror` rather than `source`, and until now nothing asserted it.
 *
 * `getRoutingSnapshot` caches at module scope, so each case imports a fresh
 * instance via `vi.resetModules()` rather than trying to invalidate the cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MirrorStatus } from '../src/lib/data/repository';

type ProbeResult = { error: unknown; count: number | null };

/**
 * Loads a fresh repository module with the Supabase boundary stubbed.
 *
 * @param configured whether credentials appear to be present
 * @param probe      what the `messages` count query does
 */
async function freshRepository(
  configured: boolean,
  probe: () => Promise<ProbeResult>,
): Promise<typeof import('../src/lib/data/repository')> {
  vi.resetModules();
  vi.doMock('../src/lib/data/supabase', () => ({
    isSupabaseConfigured: () => configured,
    getPublicClient: () =>
      configured ? { from: () => ({ select: () => probe() }) } : null,
    getServiceClient: () => {
      throw new Error('the service key must never be reachable from a render path');
    },
  }));
  return import('../src/lib/data/repository');
}

const seeded = async (): Promise<ProbeResult> => ({ error: null, count: 110 });
const empty = async (): Promise<ProbeResult> => ({ error: null, count: 0 });
const errored = async (): Promise<ProbeResult> => ({ error: { message: 'boom' }, count: null });
const thrown = async (): Promise<ProbeResult> => {
  throw new Error('connection refused');
};

async function mirrorFor(configured: boolean, probe: () => Promise<ProbeResult>): Promise<MirrorStatus> {
  const repo = await freshRepository(configured, probe);
  return (await repo.getRoutingSnapshot()).mirror;
}

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.doUnmock('../src/lib/data/supabase');
  vi.resetModules();
});

describe('mirror probing', () => {
  it('reports live when the mirror is configured, reachable and seeded', async () => {
    expect(await mirrorFor(true, seeded)).toBe('live');
  });

  it('reports unreachable when the query returns an error', async () => {
    expect(await mirrorFor(true, errored)).toBe('unreachable');
  });

  it('reports unreachable when the client throws rather than resolving', async () => {
    // A refused connection must degrade the status line, never propagate into
    // the render and blank the page.
    expect(await mirrorFor(true, thrown)).toBe('unreachable');
  });

  it('treats a reachable but unseeded mirror as unreachable', async () => {
    // The schema existing is not the same as the data being there; claiming a
    // live mirror over an empty table would be the same overstatement the
    // rename set out to remove.
    expect(await mirrorFor(true, empty)).toBe('unreachable');
  });

  it('never probes at all when no credentials are present', async () => {
    const probe = vi.fn(seeded);
    expect(await mirrorFor(false, probe)).toBe('not-configured');
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('mirror independence', () => {
  it('routes identically whether the mirror is live or absent', async () => {
    // The load-bearing assertion in this file. If a live mirror ever changed a
    // decision, "Supabase is a mirror, not a source" would be false and the
    // deployed site would not be reproducing what `npm run route` produces.
    const withMirror = await freshRepository(true, seeded);
    const live = await withMirror.getRoutingSnapshot();

    const withoutMirror = await freshRepository(false, seeded);
    const offline = await withoutMirror.getRoutingSnapshot();

    expect(live.mirror).toBe('live');
    expect(offline.mirror).toBe('not-configured');

    expect(live.decisions.map((d) => d.prediction)).toEqual(
      offline.decisions.map((d) => d.prediction),
    );
    expect(live.messages.map((m) => m.message_id)).toEqual(
      offline.messages.map((m) => m.message_id),
    );
    expect(live.evaluation).toEqual(offline.evaluation);
  });
});
