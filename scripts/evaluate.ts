/**
 * Scores the engine against the 30 solved examples in `sample_messages.csv`.
 *
 *   npm run evaluate
 *
 * The labelled rows carry their own context (they reference the same users,
 * groups and history as the live set), so they can be routed through the exact
 * same pipeline the real messages take — no separate code path, which means the
 * number this prints is a measurement of the shipped engine rather than of a
 * test harness that resembles it.
 */

import { loadContext, loadSampleMessages } from '../src/lib/data/load';
import { evaluate, formatReport } from '../src/lib/eval/score';
import { routeAll } from '../src/lib/router/engine';

function main(): void {
  const context = loadContext();
  const labelled = loadSampleMessages();

  const started = performance.now();
  const decisions = routeAll(labelled, context);
  const elapsed = performance.now() - started;

  const result = evaluate(
    decisions.map((decision) => decision.prediction),
    labelled,
  );

  console.log(formatReport(result));
  console.log(
    `\n  routed in ${elapsed.toFixed(1)}ms (${(elapsed / Math.max(1, labelled.length)).toFixed(2)}ms/message)`,
  );
}

main();
