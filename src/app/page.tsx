import Link from 'next/link';
import { Suspense } from 'react';
import { ActionChip, ConfidenceMeter, TypeChip } from '@/components/ActionChip';
import { MessageFilters } from '@/components/MessageFilters';
import { getRoutingSnapshot } from '@/lib/data/repository';
import type { Action, MessageType, RoutingDecision } from '@/lib/router/types';

export const metadata = { title: 'Triage' };

interface PageProps {
  searchParams: Promise<{ action?: string; type?: string; q?: string }>;
}

/** A short, readable summary of where a message came from. */
function describeSource(
  decision: RoutingDecision,
  snapshot: Awaited<ReturnType<typeof getRoutingSnapshot>>,
): string {
  const message = snapshot.messages.find((m) => m.message_id === decision.prediction.message_id);
  if (!message) return '';
  if (message.group_id) {
    return snapshot.context.groups.get(message.group_id)?.group_name ?? message.group_id;
  }
  if (message.business_id) {
    return snapshot.context.businesses.get(message.business_id)?.display_name ?? message.business_id;
  }
  return message.sender_user_id ? `Direct from ${message.sender_user_id}` : 'Direct message';
}

export default async function TriagePage({ searchParams }: PageProps) {
  const params = await searchParams;
  const snapshot = await getRoutingSnapshot();

  const counts = snapshot.decisions.reduce<Record<Action, number>>(
    (acc, decision) => {
      acc[decision.prediction.action] += 1;
      return acc;
    },
    { notify: 0, digest: 0, mute: 0 },
  );

  const query = params.q?.toLowerCase().trim() ?? '';

  const rows = snapshot.decisions
    .map((decision, index) => ({ decision, message: snapshot.messages[index]! }))
    .filter(({ decision, message }) => {
      if (params.action && decision.prediction.action !== params.action) return false;
      if (params.type && decision.prediction.message_type !== params.type) return false;
      if (query) {
        const haystack = `${message.message_id} ${message.user_id} ${decision.content.haystack}`;
        if (!haystack.toLowerCase().includes(query)) return false;
      }
      return true;
    });

  return (
    <div className="space-y-8">
      <section aria-labelledby="overview-heading" className="space-y-4">
        <div>
          <h1 id="overview-heading" className="text-2xl font-semibold tracking-tight">
            Message triage
          </h1>
          <p className="text-muted mt-1 max-w-2xl">
            Every message in <code>dataset/messages.csv</code>, routed to one of three
            destinations. Open any row to see the signals that produced its decision.
          </p>
        </div>

        <dl className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(
            [
              ['Notify', counts.notify, 'Interrupt now'],
              ['Digest', counts.digest, 'Show later'],
              ['Mute', counts.mute, 'Suppress'],
              ['Routed in', `${snapshot.routedInMs.toFixed(0)} ms`, `${snapshot.messages.length} messages`],
            ] as const
          ).map(([label, value, hint]) => (
            <div key={label} className="card p-4">
              <dt className="text-sm text-muted">{label}</dt>
              <dd className="text-2xl font-semibold tabular-nums mt-1">{value}</dd>
              <p className="text-xs text-muted mt-1">{hint}</p>
            </div>
          ))}
        </dl>

        <p className="text-xs text-muted">
          Data source: <strong>{snapshot.source === 'supabase' ? 'Supabase' : 'bundled CSV snapshot'}</strong>
          {snapshot.degraded && ' — Supabase is configured but unreachable, so the snapshot is being used.'}
        </p>
      </section>

      <section aria-labelledby="list-heading" className="space-y-4">
        <h2 id="list-heading" className="sr-only">
          Routed messages
        </h2>

        <Suspense fallback={<div className="card p-4 text-sm text-muted">Loading filters…</div>}>
          <MessageFilters resultCount={rows.length} />
        </Suspense>

        {rows.length === 0 ? (
          <p className="card p-6 text-center text-muted">No messages match these filters.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map(({ decision, message }) => {
              const { prediction } = decision;
              const preview =
                decision.content.text ||
                decision.content.transcript ||
                decision.content.imageText ||
                '(media only)';

              return (
                <li key={prediction.message_id}>
                  <Link
                    href={`/message/${prediction.message_id}`}
                    className="card block p-4 hover:border-[rgb(var(--accent))] transition-colors"
                  >
                    <article className="space-y-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <ActionChip action={prediction.action} />
                        <TypeChip type={prediction.message_type as MessageType} />
                        <span className="text-xs text-muted font-mono">{prediction.message_id}</span>
                        <span className="text-xs text-muted">→ {message.user_id}</span>
                        {message.media_type && (
                          <span className="text-xs text-muted border rounded px-1.5 py-0.5">
                            {message.media_type}
                          </span>
                        )}
                        <span className="ms-auto">
                          <ConfidenceMeter value={prediction.confidence} />
                        </span>
                      </div>

                      <p className="text-sm line-clamp-2">{preview}</p>

                      <p className="text-xs text-muted">
                        {describeSource(decision, snapshot)} · {prediction.reason}
                      </p>
                    </article>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
