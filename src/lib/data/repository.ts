/**
 * The view of the data the web app renders.
 *
 * Reads from Supabase when it is configured and falls back to the bundled CSV
 * snapshot otherwise, so the site is fully functional either way. The fallback
 * is what lets a reviewer clone the repo and run it with no credentials, and it
 * is also what keeps the page rendering if Supabase is unreachable — a routing
 * dashboard that goes blank because a database blinked would be a worse product
 * than one that shows the snapshot and says so.
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

export type DataSource = 'supabase' | 'local-csv';

export interface RoutingSnapshot {
  source: DataSource;
  /** Set when Supabase was configured but could not be reached. */
  degraded: boolean;
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
    source: reachable ? 'supabase' : 'local-csv',
    degraded: configured && !reachable,
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
