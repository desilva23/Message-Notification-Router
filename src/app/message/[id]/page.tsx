import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ActionChip, ConfidenceMeter, TypeChip } from '@/components/ActionChip';
import { SignalTrace } from '@/components/SignalTrace';
import { getDecision, getRoutingSnapshot } from '@/lib/data/repository';
import type { Action } from '@/lib/router/types';

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateStaticParams() {
  const snapshot = await getRoutingSnapshot();
  return snapshot.messages.map((message) => ({ id: message.message_id }));
}

export async function generateMetadata({ params }: PageProps) {
  const { id } = await params;
  const found = await getDecision(id);
  if (!found) return { title: 'Message not found' };
  return {
    title: `${id} · ${found.decision.prediction.action}`,
  };
}

export default async function MessagePage({ params }: PageProps) {
  const { id } = await params;
  const found = await getDecision(id);
  if (!found) notFound();

  const { decision, message, snapshot } = found;
  const { prediction, content } = decision;

  const group = message.group_id ? snapshot.context.groups.get(message.group_id) : undefined;
  const business = message.business_id
    ? snapshot.context.businesses.get(message.business_id)
    : undefined;
  const user = snapshot.context.users.get(message.user_id);

  const imagePath = message.media_type === 'image' ? snapshot.mediaPaths.images[message.media_id] : undefined;
  const audioPath = message.media_type === 'voice' ? snapshot.mediaPaths.voiceNotes[message.media_id] : undefined;
  const voice = message.media_type === 'voice' ? snapshot.context.media.voice_notes[message.media_id] : undefined;

  const facts: [string, string][] = [
    ['Recipient', message.user_id],
    ['Conversation', message.conversation_type],
    group ? ['Group', `${group.group_name} (${group.group_type}, ${group.member_count} members)`] : null,
    business
      ? ['Business', `${business.display_name} — ${business.verified ? 'verified' : 'unverified'}, sends from ${business.domain_used_by_sender || 'unknown domain'}`]
      : null,
    message.sender_user_id ? ['Sender', message.sender_user_id] : null,
    ['Received', message.created_at],
    ['Forwarded', `${message.forwarded_count} times`],
    user ? ['Quiet hours', user.do_not_disturb_window] : null,
    content.scripts.length > 0 ? ['Detected scripts', content.scripts.join(', ')] : null,
  ].filter((entry): entry is [string, string] => entry !== null);

  return (
    <div className="space-y-8">
      <nav aria-label="Breadcrumb">
        <Link href="/" className="text-sm text-[rgb(var(--accent))] hover:underline">
          ← Back to triage
        </Link>
      </nav>

      <header className="space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <ActionChip action={prediction.action as Action} />
          <TypeChip type={prediction.message_type} />
          <ConfidenceMeter value={prediction.confidence} />
        </div>
        <h1 className="text-2xl font-semibold tracking-tight font-mono">{prediction.message_id}</h1>
        <p className="text-muted max-w-2xl">{prediction.reason}</p>
        {decision.override && (
          <p className="card border-[rgb(var(--notify))]/40 p-3 text-sm">
            <strong className="font-semibold">Override applied.</strong> {decision.override}
          </p>
        )}
      </header>

      <div className="grid gap-8 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] items-start">
        <div className="space-y-8 min-w-0">
          <section aria-labelledby="content-heading" className="card p-5 space-y-4">
            <h2 id="content-heading" className="text-lg font-semibold">
              Message content
            </h2>

            {content.text && (
              <div>
                <h3 className="text-sm font-medium text-muted mb-1">Text</h3>
                <p className="whitespace-pre-wrap text-sm">{content.text}</p>
              </div>
            )}

            {content.quarantined.length > 0 && (
              <div>
                <h3 className="text-sm font-medium text-[rgb(var(--notify))] mb-1">
                  Quarantined — instructions aimed at the router
                </h3>
                <p className="text-xs text-muted mb-2">
                  Removed before scoring and treated as evidence of manipulation. Shown here for
                  audit; it was never interpreted as a command.
                </p>
                <ul className="space-y-1">
                  {content.quarantined.map((span) => (
                    <li key={span}>
                      <code className="block text-xs bg-[rgb(var(--surface))] border rounded p-2 whitespace-pre-wrap break-words">
                        {span}
                      </code>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {imagePath && (
              <div>
                <h3 className="text-sm font-medium text-muted mb-2">Attached image</h3>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={`/${imagePath.replace(/^media\//, 'media/')}`}
                  alt={
                    snapshot.context.media.images[message.media_id]?.description ??
                    'Image attached to this message'
                  }
                  className="max-w-full h-auto rounded-lg border"
                  loading="lazy"
                />
                {content.imageText && (
                  <p className="text-xs text-muted mt-2">
                    <strong className="font-medium">Text read from image:</strong> {content.imageText}
                  </p>
                )}
              </div>
            )}

            {audioPath && (
              <div>
                <h3 className="text-sm font-medium text-muted mb-2">Voice note</h3>
                <audio controls preload="none" className="w-full" src={`/${audioPath}`}>
                  <track kind="captions" />
                  Your browser does not support audio playback.
                </audio>
                {content.transcript && (
                  <blockquote className="mt-2 text-sm border-s-2 ps-3 text-muted">
                    “{content.transcript}”
                    {voice && (
                      <footer className="text-xs mt-1">
                        Transcribed automatically · {voice.language} · {voice.duration_sec.toFixed(1)}s
                      </footer>
                    )}
                  </blockquote>
                )}
              </div>
            )}
          </section>

          <section aria-labelledby="signals-heading" className="card p-5 space-y-4">
            <h2 id="signals-heading" className="text-lg font-semibold">
              Why this decision
            </h2>
            <SignalTrace signals={decision.signals} />
          </section>
        </div>

        <div className="space-y-8 min-w-0">
          <section aria-labelledby="scores-heading" className="card p-5 space-y-3">
            <h2 id="scores-heading" className="text-lg font-semibold">
              Action scores
            </h2>
            <dl className="space-y-2 text-sm">
              {(['notify', 'digest', 'mute'] as const).map((action) => (
                <div key={action} className="flex items-center justify-between gap-3">
                  <dt className={action === prediction.action ? 'font-semibold' : 'text-muted'}>
                    {action}
                    {action === prediction.action && <span className="sr-only"> (chosen)</span>}
                  </dt>
                  <dd className="tabular-nums">{decision.scores[action].toFixed(3)}</dd>
                </div>
              ))}
            </dl>
            <p className="text-xs text-muted border-t pt-3">
              Margin over the runner-up: <strong>{decision.margin.toFixed(3)}</strong>.
              {decision.margin < 0.08 && ' Narrow — this is a borderline call.'}
            </p>
          </section>

          <section aria-labelledby="facts-heading" className="card p-5">
            <h2 id="facts-heading" className="text-lg font-semibold mb-3">
              Context
            </h2>
            <dl className="space-y-2 text-sm">
              {facts.map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted text-xs">{label}</dt>
                  <dd className="break-words">{value}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="evidence-heading" className="card p-5">
            <h2 id="evidence-heading" className="text-lg font-semibold mb-3">
              Historical evidence
            </h2>
            {decision.evidence.length === 0 ? (
              <p className="text-sm text-muted">
                None cited. No earlier message supports this decision — which is itself meaningful
                when the sender is new.
              </p>
            ) : (
              <ul className="space-y-3">
                {decision.evidence.map((item) => {
                  const past = snapshot.context.history.get(item.message_id);
                  return (
                    <li key={item.message_id} className="text-sm">
                      <p className="font-mono text-xs text-muted">{item.message_id}</p>
                      {past && (
                        <p className="line-clamp-3 mt-0.5">
                          {past.message_text || '(media message)'}
                        </p>
                      )}
                      <p className="text-xs text-muted mt-1">{item.reason}</p>
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
