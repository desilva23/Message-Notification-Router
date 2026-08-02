/**
 * Seeds Supabase from the bundled CSV snapshot, then records a routing run.
 *
 *   npm run db:seed
 *
 * Requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY, and assumes
 * `supabase/schema.sql` has already been applied.
 *
 * Idempotent: every write is an upsert keyed on the table's primary key, so
 * re-running refreshes the data rather than duplicating it.
 */

import { loadContext, loadMessages, loadRawDataset } from '../src/lib/data/load';
import { getServiceClient } from '../src/lib/data/supabase';
import { routeAll } from '../src/lib/router/engine';

/** Supabase rejects very large single payloads; 500 rows is comfortably safe. */
const BATCH_SIZE = 500;

type Client = ReturnType<typeof getServiceClient>;

async function upsert(
  client: Client,
  table: string,
  rows: readonly object[],
  conflictTarget: string,
): Promise<void> {
  if (rows.length === 0) {
    console.log(`  ${table}: nothing to seed`);
    return;
  }

  for (let offset = 0; offset < rows.length; offset += BATCH_SIZE) {
    const batch = rows.slice(offset, offset + BATCH_SIZE);
    const { error } = await client.from(table).upsert(batch, { onConflict: conflictTarget });
    if (error) {
      throw new Error(`${table}: ${error.message}`);
    }
  }
  console.log(`  ${table}: ${rows.length} rows`);
}

async function main(): Promise<void> {
  const client = getServiceClient();
  const dataset = loadRawDataset();

  console.log('Seeding reference tables...');

  // Ordered so foreign keys always resolve against rows that already exist.
  await upsert(client, 'users', dataset.users, 'user_id');
  await upsert(client, 'groups', dataset.groups, 'group_id');
  await upsert(client, 'group_members', dataset.groupMembers, 'group_id,user_id');
  await upsert(client, 'business_accounts', dataset.businesses, 'business_id');
  await upsert(client, 'user_business_history', dataset.userBusiness, 'user_id,business_id');
  await upsert(client, 'message_history', dataset.history, 'message_id');
  await upsert(client, 'message_events', dataset.events, 'user_id,message_id');
  await upsert(client, 'daily_notification_summary', dataset.dailyNotifications, 'user_id,date');

  const messages = loadMessages();
  await upsert(client, 'messages', messages, 'message_id');

  const mediaRows = [
    ...Object.entries(dataset.media.images).map(([media_id, analysis]) => ({
      media_id,
      media_kind: 'image' as const,
      analysis,
    })),
    ...Object.entries(dataset.media.voice_notes).map(([media_id, analysis]) => ({
      media_id,
      media_kind: 'voice' as const,
      analysis,
    })),
  ];
  await upsert(client, 'media_analysis', mediaRows, 'media_id');

  console.log('\nRouting and recording a run...');
  const decisions = routeAll(messages, loadContext());

  const { data: run, error: runError } = await client
    .from('routing_runs')
    .insert({
      engine_version: '1.0.0',
      adjudicator: process.env.ROUTER_LLM_ADJUDICATOR?.toLowerCase() === 'on',
      message_count: decisions.length,
      notes: 'Seeded from dataset/ CSV snapshot',
    })
    .select('id')
    .single();

  if (runError || !run) {
    throw new Error(`routing_runs: ${runError?.message ?? 'no row returned'}`);
  }

  await upsert(
    client,
    'routing_predictions',
    decisions.map((decision) => ({
      run_id: run.id as string,
      ...decision.prediction,
      signals: decision.signals,
    })),
    'run_id,message_id',
  );

  console.log(`\nDone. Run id: ${run.id}`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
