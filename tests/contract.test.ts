/**
 * Submission-contract tests.
 *
 * These assert the properties the challenge specification fixes: one row per
 * input message, in order, with the exact columns and only permitted values.
 * A regression here is unrecoverable at grading time — the file is simply
 * rejected — so it is checked from the shipped `output.csv`, not from an
 * in-memory approximation of it.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseCsv, parseCsvRows } from '../src/lib/data/csv';
import { permittedConfidences } from '../src/lib/router/confidence';
import { routeAll } from '../src/lib/router/engine';
import { REASONS } from '../src/lib/router/reasons';
import { ACTIONS, MESSAGE_TYPES } from '../src/lib/router/types';
import { realContext, realMessages } from './helpers';

const OUTPUT_PATH = join(process.cwd(), 'output.csv');
const REQUIRED_COLUMNS = [
  'message_id',
  'action',
  'message_type',
  'reason',
  'confidence',
  'evidence_message_ids',
];

describe('output.csv', () => {
  it('exists — run `npm run route` before the suite', () => {
    expect(existsSync(OUTPUT_PATH)).toBe(true);
  });

  const raw = existsSync(OUTPUT_PATH) ? readFileSync(OUTPUT_PATH, 'utf8') : '';
  const rows = raw ? parseCsv(raw) : [];

  it('has exactly the required columns in the required order', () => {
    const header = parseCsvRows(raw)[0];
    expect(header).toEqual(REQUIRED_COLUMNS);
  });

  it('has one row per input message, in the same order', () => {
    const expected = realMessages().map((message) => message.message_id);
    expect(rows.map((row) => row.message_id)).toEqual(expected);
  });

  it('uses only permitted actions and message types', () => {
    for (const row of rows) {
      expect(ACTIONS as readonly string[]).toContain(row.action);
      expect(MESSAGE_TYPES as readonly string[]).toContain(row.message_type);
    }
  });

  it('has a confidence in [0, 1] on every row', () => {
    for (const row of rows) {
      const confidence = Number(row.confidence);
      expect(Number.isNaN(confidence)).toBe(false);
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
    }
  });

  it('never leaves reason or evidence blank', () => {
    for (const row of rows) {
      expect(row.reason?.trim().length ?? 0).toBeGreaterThan(0);
      expect(row.evidence_message_ids?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it('cites evidence ids that exist in the historical corpus', () => {
    const context = realContext();
    for (const row of rows) {
      const value = row.evidence_message_ids ?? '';
      if (value === 'none') continue;
      for (const id of value.split(';')) {
        expect(context.history.has(id), `${row.message_id} cites unknown ${id}`).toBe(true);
      }
    }
  });
});

describe('engine invariants', () => {
  const context = realContext();
  const messages = realMessages();
  const decisions = routeAll(messages, context);

  it('is deterministic across runs', () => {
    const again = routeAll(messages, context);
    expect(again.map((d) => d.prediction)).toEqual(decisions.map((d) => d.prediction));
  });

  it('emits only calibrated confidence values', () => {
    const permitted = new Set(permittedConfidences());
    for (const decision of decisions) {
      expect(permitted, decision.prediction.message_id).toContain(decision.prediction.confidence);
    }
  });

  it('draws every reason from the canonical bank', () => {
    const bank = new Set<string>(Object.values(REASONS));
    for (const decision of decisions) {
      expect(bank, decision.prediction.message_id).toContain(decision.prediction.reason);
    }
  });

  it('never routes a scam anywhere but mute', () => {
    for (const decision of decisions) {
      if (decision.prediction.message_type === 'scam') {
        expect(decision.prediction.action, decision.prediction.message_id).toBe('mute');
      }
    }
  });

  it('routes identical text differently for two users with opposite histories', () => {
    // msg_103 and msg_104 carry the same words to different recipients: one who
    // replies to this seller, one who has dismissed everything from them. If
    // these ever agree, personalisation has silently stopped working — and no
    // aggregate accuracy number would reveal it.
    const byId = new Map(decisions.map((d) => [d.prediction.message_id, d.prediction]));
    const engaged = byId.get('msg_103');
    const fatigued = byId.get('msg_104');

    expect(engaged).toBeDefined();
    expect(fatigued).toBeDefined();
    expect(engaged?.action).not.toBe(fatigued?.action);
  });

  it('never gives a reason that its own cited evidence contradicts', () => {
    // The reason and the evidence are read together. A reason asserting the
    // user "usually ignores" this kind of message while citing one they opened
    // is visibly self-contradicting — worse than a vaguer but truthful phrase.
    const CLAIMS_DISINTEREST =
      /usually ignores|opted out of or repeatedly dismissed|ignored, dismissed, or muted/;

    for (const decision of decisions) {
      if (!CLAIMS_DISINTEREST.test(decision.prediction.reason)) continue;
      const engaged = decision.evidence.some(
        (item) => item.outcome === 'opened' || item.outcome === 'replied',
      );
      expect(engaged, `${decision.prediction.message_id}: ${decision.prediction.reason}`).toBe(false);
    }
  });

  it('attributes every decision to at least one named signal or an override', () => {
    for (const decision of decisions) {
      const explained = decision.signals.length > 0 || Boolean(decision.override);
      expect(explained, decision.prediction.message_id).toBe(true);
    }
  });

  it('routes the whole batch well inside a request budget', () => {
    const started = performance.now();
    routeAll(messages, context);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
  });
});
