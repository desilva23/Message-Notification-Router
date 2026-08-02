import type { Signal } from '@/lib/router/types';

/**
 * The weighted signals behind a decision.
 *
 * This is the component the whole engine design exists to make possible: every
 * number in the routing decision traces back to a named, human-readable line
 * here. A reviewer who disagrees with an outcome can see precisely which rule
 * produced it rather than having to guess at a model's reasoning.
 *
 * Rendered as a table because that is what it is — rows of labelled
 * measurements — which also means screen readers announce the column meanings
 * with each cell.
 */
export function SignalTrace({ signals }: { signals: readonly Signal[] }) {
  if (signals.length === 0) {
    return <p className="text-sm text-muted">No signals fired; the decision used the baseline only.</p>;
  }

  const sorted = [...signals].sort((a, b) => Math.abs(b.weight) - Math.abs(a.weight));
  const peak = Math.max(...sorted.map((signal) => Math.abs(signal.weight)), 0.1);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm border-collapse">
        <caption className="sr-only">
          Signals contributing to this routing decision, strongest first. A positive weight argues
          for interrupting the user; a negative weight argues against.
        </caption>
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="py-2 pr-4 font-medium">Signal</th>
            <th scope="col" className="py-2 pr-4 font-medium">Detail</th>
            <th scope="col" className="py-2 pr-4 font-medium text-right">Weight</th>
            <th scope="col" className="py-2 font-medium w-28">
              <span aria-hidden="true">Magnitude</span>
              <span className="sr-only">Relative magnitude</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((signal) => {
            const positive = signal.weight >= 0;
            return (
              <tr key={`${signal.code}-${signal.weight}`} className="border-t align-top">
                <th scope="row" className="py-2.5 pr-4 font-normal">
                  <span className="block">{signal.label}</span>
                  <code className="block text-xs text-muted mt-0.5">{signal.code}</code>
                </th>
                <td className="py-2.5 pr-4 text-muted">{signal.detail ?? '—'}</td>
                <td
                  className={`py-2.5 pr-4 text-right tabular-nums font-medium ${
                    positive ? 'text-[rgb(var(--notify))]' : 'text-[rgb(var(--digest))]'
                  }`}
                >
                  {positive ? '+' : ''}
                  {signal.weight.toFixed(2)}
                </td>
                <td className="py-2.5">
                  {/* Decorative: the exact value is already in the previous cell. */}
                  <span
                    className="signal-bar block h-2 rounded-full bg-current opacity-60"
                    style={{ width: `${Math.round((Math.abs(signal.weight) / peak) * 100)}%` }}
                    aria-hidden="true"
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
