/**
 * Prints the full signal trace for one or more messages.
 *
 *   npm run explain -- sample_msg_044 msg_107
 *
 * The engine's whole design premise is that every decision decomposes into
 * named contributions, so this is the tool that makes a wrong prediction
 * diagnosable — it shows which signal fired and by how much, rather than
 * leaving a score to be reverse-engineered.
 */

import { loadContext, loadMessages, loadSampleMessages } from '../src/lib/data/load';
import { buildSimilarityIndex, routeMessage } from '../src/lib/router/engine';

function main(): void {
  const ids = process.argv.slice(2);
  if (ids.length === 0) {
    console.error('Usage: npm run explain -- <message_id> [message_id...]');
    process.exitCode = 1;
    return;
  }

  const context = loadContext();
  const index = buildSimilarityIndex(context);

  const samples = loadSampleMessages();
  const byId = new Map<string, (typeof samples)[number] | ReturnType<typeof loadMessages>[number]>();
  for (const message of loadMessages()) byId.set(message.message_id, message);
  for (const message of samples) byId.set(message.message_id, message);

  const labels = new Map(samples.map((sample) => [sample.message_id, sample]));

  for (const id of ids) {
    const message = byId.get(id);
    if (!message) {
      console.error(`unknown message: ${id}`);
      continue;
    }

    const decision = routeMessage(message, context, index);
    const label = labels.get(id);

    console.log(`\n${'='.repeat(78)}`);
    console.log(`${id}  user=${message.user_id}  ${message.conversation_type}` +
      `${message.group_id ? ` group=${message.group_id}` : ''}` +
      `${message.business_id ? ` business=${message.business_id}` : ''}` +
      `${message.sender_user_id ? ` sender=${message.sender_user_id}` : ''}` +
      `  fwd=${message.forwarded_count}`);
    console.log('='.repeat(78));

    const body = decision.content.text.replace(/\s+/g, ' ').slice(0, 300);
    if (body) console.log(`text:       ${body}`);
    if (decision.content.imageText) {
      console.log(`image OCR:  ${decision.content.imageText.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    if (decision.content.transcript) {
      console.log(`transcript: ${decision.content.transcript.replace(/\s+/g, ' ').slice(0, 200)}`);
    }
    if (decision.content.quarantined.length > 0) {
      console.log(`QUARANTINED: ${decision.content.quarantined.join(' | ').slice(0, 240)}`);
    }
    if (decision.content.scripts.length > 0) {
      console.log(`scripts:    ${decision.content.scripts.join(', ')}`);
    }

    console.log('\nsignals:');
    for (const signal of [...decision.signals].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight))) {
      const sign = signal.weight >= 0 ? '+' : '';
      console.log(
        `  ${sign}${signal.weight.toFixed(2).padStart(6)}  ${signal.code.padEnd(36)} ${signal.detail ?? ''}`,
      );
    }

    console.log(
      `\nscores:  notify=${decision.scores.notify.toFixed(3)}` +
        `  digest=${decision.scores.digest.toFixed(3)}` +
        `  mute=${decision.scores.mute.toFixed(3)}  (margin ${decision.margin.toFixed(3)})`,
    );
    if (decision.override) console.log(`override: ${decision.override}`);

    console.log('\nevidence:');
    if (decision.evidence.length === 0) console.log('  none');
    for (const item of decision.evidence) {
      console.log(`  ${item.message_id}  score=${item.score.toFixed(3)}  ${item.reason}`);
    }

    const { prediction } = decision;
    console.log(
      `\nPREDICTED: ${prediction.action} / ${prediction.message_type} @ ${prediction.confidence}`,
    );
    console.log(`  reason:   ${prediction.reason}`);
    console.log(`  evidence: ${prediction.evidence_message_ids}`);
    if (label) {
      const ok = label.action === prediction.action && label.message_type === prediction.message_type;
      console.log(`EXPECTED:  ${label.action} / ${label.message_type} @ ${label.confidence}  ${ok ? 'OK' : '<<< MISMATCH'}`);
      console.log(`  reason:   ${label.reason}`);
      console.log(`  evidence: ${label.evidence_message_ids}`);
    }
  }
}

main();
