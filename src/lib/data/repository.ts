/**
 * The view of the data the web app renders.
 *
 * Rendering always reads the bundled CSV snapshot. That is a deliberate choice,
 * not a missing feature: the submission contract requires a reviewer to clone
 * the repo with no credentials and reproduce `output.csv` exactly, so the render
 * path cannot depend on a network round trip or on whichever rows a database
 * happens to hold. Routing is a pure function of the snapshot either way.
 *
 * Supabase is therefore a *mirror*, not a source. `supabase/schema.sql` and
 * `npm run db:seed` publish the same reference data to Postgres under row level
 * security, and this module probes it so the UI can report whether that mirror
 * is answering. The probe is a `head: true` count — it returns no rows, and no
 * rendered value is ever derived from it. Nothing downstream reads Supabase.
 *
 * Server-only. Reads the filesystem and, when configured, holds a Supabase
 * client; never import this from a client component.
 */

import 'server-only';
import { loadContext, loadMediaPaths, loadMessages, loadSampleMessages } from './load';
import { getPublicClient, isSupabaseConfigured } from './supabase';
import { evaluate, type EvaluationResult } from '../eval/score';
import { routeAll } from '../router/engine';
import type { Message, RouterContext, RoutingDecision } from '../router/types';

/**
 * Liveness of the optional Supabase mirror.
 *
 * Deliberately not a provenance field. An earlier `DataSource` named this
 * `'supabase' | 'local-csv'`, which read as though the rendered rows had come
 * from whichever one won — they never do. Naming it for what it measures keeps
 * the UI from making a claim the code does not support.
 */
export type MirrorStatus = 'live' | 'unreachable' | 'not-configured';

/**
 * Maps probe results onto the reported status.
 *
 * Pure and exported so the three branches are directly testable — the caller
 * needs credentials and a network round trip to reach two of them, which is
 * exactly the kind of code that otherwise ships unverified.
 */
export function mirrorStatus(configured: boolean, reachable: boolean): MirrorStatus {
  if (!configured) return 'not-configured';
  return reachable ? 'live' : 'unreachable';
}

export interface RoutingSnapshot {
  /**
   * Whether the Supabase mirror answered. Reporting only — every field below is
   * computed from the bundled snapshot regardless of this value.
   */
  mirror: MirrorStatus;
  context: RouterContext;
  messages: Message[];
  decisions: RoutingDecision[];
  evaluation: EvaluationResult;
  mediaPaths: { images: Record<string, string>; voiceNotes: Record<string, string> };
  routedInMs: number;
}

/**
 * Cached across requests within a server instance.
 *
 * Routing is deterministic and the dataset is static, so recomputing per
 * request would burn CPU to produce a byte-identical answer.
 */
let cached: RoutingSnapshot | null = null;

/**
 * Confirms Supabase is reachable and seeded.
 *
 * Only the reachability check happens over the network — the routing itself
 * always runs locally against the same engine, so the displayed decisions never
 * depend on which data source answered.
 */
async function probeSupabase(): Promise<boolean> {
  const client = getPublicClient();
  if (!client) return false;

  try {
    const { error, count } = await client
      .from('messages')
      .select('message_id', { count: 'exact', head: true });
    return !error && (count ?? 0) > 0;
  } catch {
    return false;
  }
}

export async function getRoutingSnapshot(): Promise<RoutingSnapshot> {
  if (cached) return cached;

  const configured = isSupabaseConfigured();
  const reachable = configured ? await probeSupabase() : false;

  const context = loadContext();
  const messages = loadMessages();

  const started = performance.now();
  const decisions = routeAll(messages, context);
  const routedInMs = performance.now() - started;

  const samples = loadSampleMessages();
  const sampleDecisions = routeAll(samples, context);
  const evaluation = evaluate(
    sampleDecisions.map((decision) => decision.prediction),
    samples,
  );

  cached = {
    mirror: mirrorStatus(configured, reachable),
    context,
    messages,
    decisions,
    evaluation,
    mediaPaths: loadMediaPaths(),
    routedInMs,
  };

  return cached;
}

/** Looks up one message's decision, or undefined when the id is unknown. */
export async function getDecision(messageId: string): Promise<
  { decision: RoutingDecision; message: Message; snapshot: RoutingSnapshot } | undefined
> {
  const snapshot = await getRoutingSnapshot();
  const index = snapshot.messages.findIndex((message) => message.message_id === messageId);
  if (index === -1) return undefined;

  const decision = snapshot.decisions[index];
  const message = snapshot.messages[index];
  if (!decision || !message) return undefined;

  return { decision, message, snapshot };
}
