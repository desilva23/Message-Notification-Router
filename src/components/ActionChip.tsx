import type { Action, MessageType } from '@/lib/router/types';

/**
 * The routing decision, rendered as a labelled chip.
 *
 * Colour is never the only carrier of meaning here — the word "notify",
 * "digest" or "mute" is always present — so the chip stays readable for anyone
 * who cannot distinguish the hues, and in forced-colours mode.
 */
export function ActionChip({ action, className = '' }: { action: Action; className?: string }) {
  const styles: Record<Action, string> = {
    notify: 'bg-[rgb(var(--notify))]/12 text-[rgb(var(--notify))] border-[rgb(var(--notify))]/35',
    digest: 'bg-[rgb(var(--digest))]/12 text-[rgb(var(--digest))] border-[rgb(var(--digest))]/35',
    mute: 'bg-[rgb(var(--mute))]/12 text-[rgb(var(--mute))] border-[rgb(var(--mute))]/35',
  };

  return (
    <span
      className={`action-chip inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${styles[action]} ${className}`}
    >
      {action}
    </span>
  );
}

/** The message category, rendered as a neutral chip. */
export function TypeChip({ type }: { type: MessageType }) {
  // Only the two safety categories are tinted; everything else stays neutral so
  // the tint means "this one is dangerous" rather than merely "this is a chip".
  const risky = type === 'scam' || type === 'spam';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        risky
          ? 'border-[rgb(var(--notify))]/40 text-[rgb(var(--notify))]'
          : 'border-[rgb(var(--line))] text-muted'
      }`}
    >
      {type.replace('_', ' ')}
    </span>
  );
}

/**
 * Confidence, shown as a number with a meter.
 *
 * `<meter>` carries the value semantically, so a screen reader announces the
 * measurement rather than describing a decorative bar.
 */
export function ConfidenceMeter({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-2">
      <meter
        min={0}
        max={1}
        value={value}
        low={0.8}
        high={0.86}
        optimum={1}
        className="w-16 h-2"
        aria-label={`Confidence ${value.toFixed(2)} out of 1`}
      />
      <span className="tabular-nums text-xs text-muted">{value.toFixed(2)}</span>
    </span>
  );
}
