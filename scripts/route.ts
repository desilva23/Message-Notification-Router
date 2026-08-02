/**
 * CLI entry point: routes every message and writes `output.csv`.
 *
 *   npm run route              # writes ./output.csv
 *   npm run route -- --out x   # writes to a different path
 *   npm run route -- --json    # also writes output.decisions.json with full
 *                              # signal traces, for the web app and debugging
 *
 * Requires no credentials and makes no network calls.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { toCsv } from '../src/lib/data/csv';
import { loadContext, loadMessages } from '../src/lib/data/load';
import { adjudicateBatch } from '../src/lib/llm/adjudicator';
import { routeAll } from '../src/lib/router/engine';
import type { Prediction } from '../src/lib/router/types';

/** The exact column order the submission contract requires. */
const OUTPUT_COLUMNS = [
  'message_id',
  'action',
  'message_type',
  'reason',
  'confidence',
  'evidence_message_ids',
] as const satisfies readonly (keyof Prediction)[];

interface Options {
  out: string;
  json: boolean;
}

function parseArgs(argv: readonly string[]): Options {
  const options: Options = { out: resolve(process.cwd(), 'output.csv'), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      const value = argv[i + 1];
      if (!value) throw new Error('--out requires a path');
      options.out = resolve(process.cwd(), value);
      i += 1;
    } else if (arg === '--json') {
      options.json = true;
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const started = performance.now();

  const context = loadContext();
  const messages = loadMessages();
  const loadedAt = performance.now();

  const decisions = routeAll(messages, context);
  const routedAt = performance.now();

  // Optional second opinion on borderline calls. A no-op unless both
  // ROUTER_LLM_ADJUDICATOR=on and GROQ_API_KEY are set.
  const adjudicated = await adjudicateBatch(decisions, messages, context);
  const finishedAt = performance.now();

  const predictions = adjudicated.map((decision) => decision.prediction);

  // Fail loudly rather than submit a file that silently breaks the contract.
  assertContract(predictions, messages.map((message) => message.message_id));

  writeFileSync(options.out, toCsv(predictions, OUTPUT_COLUMNS), 'utf8');

  if (options.json) {
    const jsonPath = options.out.replace(/\.csv$/, '.decisions.json');
    writeFileSync(jsonPath, JSON.stringify(adjudicated, null, 2), 'utf8');
    console.log(`Wrote ${jsonPath}`);
  }

  const counts = tally(predictions);
  console.log(`Routed ${predictions.length} messages -> ${options.out}`);
  console.log(
    `  actions: notify=${counts.actions.notify ?? 0} digest=${counts.actions.digest ?? 0} mute=${counts.actions.mute ?? 0}`,
  );
  console.log(
    `  types:   ${Object.entries(counts.types)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}=${count}`)
      .join(' ')}`,
  );
  const adjustments = adjudicated.filter((decision) => decision.adjudication?.applied).length;
  if (adjustments > 0) console.log(`  adjudicator changed ${adjustments} decision(s)`);
  console.log(
    `  timing:  load ${(loadedAt - started).toFixed(0)}ms, route ${(routedAt - loadedAt).toFixed(0)}ms` +
      `, adjudicate ${(finishedAt - routedAt).toFixed(0)}ms`,
  );
}

/** Verifies the output satisfies the submission contract before it is written. */
function assertContract(predictions: readonly Prediction[], expectedIds: readonly string[]): void {
  if (predictions.length !== expectedIds.length) {
    throw new Error(`Expected ${expectedIds.length} predictions, produced ${predictions.length}`);
  }
  for (let i = 0; i < expectedIds.length; i += 1) {
    if (predictions[i]?.message_id !== expectedIds[i]) {
      throw new Error(`Row ${i}: expected ${expectedIds[i]}, got ${predictions[i]?.message_id}`);
    }
  }
  for (const prediction of predictions) {
    if (prediction.confidence < 0 || prediction.confidence > 1) {
      throw new Error(`${prediction.message_id}: confidence ${prediction.confidence} out of range`);
    }
    if (!prediction.reason.trim()) {
      throw new Error(`${prediction.message_id}: empty reason`);
    }
    if (!prediction.evidence_message_ids.trim()) {
      throw new Error(`${prediction.message_id}: empty evidence column (use "none")`);
    }
  }
}

function tally(predictions: readonly Prediction[]): {
  actions: Record<string, number>;
  types: Record<string, number>;
} {
  const actions: Record<string, number> = {};
  const types: Record<string, number> = {};
  for (const prediction of predictions) {
    actions[prediction.action] = (actions[prediction.action] ?? 0) + 1;
    types[prediction.message_type] = (types[prediction.message_type] ?? 0) + 1;
  }
  return { actions, types };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
