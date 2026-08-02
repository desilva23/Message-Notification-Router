import { getRoutingSnapshot } from '@/lib/data/repository';

export const metadata = { title: 'Evaluation' };

const METRICS = [
  {
    key: 'actionAccuracy' as const,
    label: 'Action accuracy',
    hint: 'Share of labelled examples routed to the correct destination.',
  },
  {
    key: 'typeAccuracy' as const,
    label: 'Category accuracy',
    hint: 'Share assigned the correct message_type.',
  },
  {
    key: 'reasonConsistency' as const,
    label: 'Reason consistency',
    hint: 'Share whose explanation came from the canonical phrase bank.',
  },
  {
    key: 'evidenceAgreement' as const,
    label: 'Evidence agreement',
    hint: 'Share agreeing with the label on whether any evidence exists.',
  },
  {
    key: 'evidencePrecision' as const,
    label: 'Evidence precision',
    hint: 'Share whose cited ids overlap the labelled set.',
  },
];

export default async function EvaluationPage() {
  const snapshot = await getRoutingSnapshot();
  const { evaluation } = snapshot;
  const pct = (value: number) => `${(value * 100).toFixed(1)}%`;

  return (
    <div className="space-y-8">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Evaluation</h1>
        <p className="text-muted mt-1 max-w-2xl">
          Measured against the {evaluation.total} solved examples in{' '}
          <code>dataset/sample_messages.csv</code>, routed through the same pipeline the live
          messages take — so these numbers describe the shipped engine, not a test harness that
          resembles it.
        </p>
      </header>

      <section aria-labelledby="metrics-heading">
        <h2 id="metrics-heading" className="text-lg font-semibold mb-3">
          Scores
        </h2>
        <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {METRICS.map((metric) => (
            <div key={metric.key} className="card p-4">
              <dt className="text-sm text-muted">{metric.label}</dt>
              <dd className="text-2xl font-semibold tabular-nums mt-1">
                {pct(evaluation[metric.key])}
              </dd>
              <p className="text-xs text-muted mt-1">{metric.hint}</p>
            </div>
          ))}
          <div className="card p-4">
            <dt className="text-sm text-muted">Confidence calibration</dt>
            <dd className="text-2xl font-semibold tabular-nums mt-1">
              {evaluation.meanConfidence.toFixed(3)}
            </dd>
            <p className="text-xs text-muted mt-1">
              Mean stated confidence. The labelled examples average 0.836, and never exceed 0.91.
            </p>
          </div>
        </dl>
      </section>

      <section aria-labelledby="calibration-heading" className="card p-5">
        <h2 id="calibration-heading" className="text-lg font-semibold mb-2">
          On calibration
        </h2>
        <p className="text-sm text-muted max-w-3xl">
          Confidence is quantised into per-action bands taken from the labelled distribution:
          notify 0.85–0.91, mute 0.81–0.87, digest 0.78–0.84. Two properties are preserved
          deliberately. Nothing is ever above 0.91, because a system deciding whether to interrupt
          someone should not claim certainty. And <code>digest</code> sits lowest, because it is the
          hedge — chosen when neither interrupting nor suppressing is clearly right, and its number
          should say so.
        </p>
      </section>

      {(evaluation.actionConfusion.length > 0 || evaluation.typeConfusion.length > 0) && (
        <section aria-labelledby="confusion-heading" className="card p-5">
          <h2 id="confusion-heading" className="text-lg font-semibold mb-3">
            Confusions
          </h2>
          <div className="grid gap-6 sm:grid-cols-2">
            {(
              [
                ['Action', evaluation.actionConfusion],
                ['Category', evaluation.typeConfusion],
              ] as const
            ).map(([label, cells]) => (
              <div key={label}>
                <h3 className="text-sm font-medium mb-2">{label}</h3>
                {cells.length === 0 ? (
                  <p className="text-sm text-muted">None.</p>
                ) : (
                  <ul className="text-sm space-y-1">
                    {cells.map((cell) => (
                      <li key={`${cell.expected}-${cell.actual}`}>
                        <code>{cell.expected}</code> → <code>{cell.actual}</code>: {cell.count}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      <section aria-labelledby="perf-heading" className="card p-5">
        <h2 id="perf-heading" className="text-lg font-semibold mb-2">
          Performance
        </h2>
        <p className="text-sm text-muted max-w-3xl">
          Routing all {snapshot.messages.length} messages — including similarity retrieval over a
          412-message corpus — takes{' '}
          <strong className="text-ink">{snapshot.routedInMs.toFixed(0)} ms</strong> in total, about{' '}
          {(snapshot.routedInMs / Math.max(1, snapshot.messages.length)).toFixed(2)} ms per message.
          The engine performs no I/O and makes no network calls, so this is the whole cost.
        </p>
      </section>
    </div>
  );
}
