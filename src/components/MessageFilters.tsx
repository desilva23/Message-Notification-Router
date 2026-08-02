'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useId, useTransition } from 'react';
import { ACTIONS, MESSAGE_TYPES } from '@/lib/router/types';

/**
 * Filter controls for the triage list.
 *
 * State lives in the URL rather than in component state, which makes a filtered
 * view linkable, survivable across reloads, and navigable with the browser's
 * back button — all behaviours users expect and none of which come for free
 * from `useState`.
 *
 * It is a real `<form>` with a submit button, so it works before hydration and
 * for anyone driving the page from the keyboard alone. The auto-submit on
 * change is an enhancement layered on top, not the only way through.
 */
export function MessageFilters({ resultCount }: { resultCount: number }) {
  const router = useRouter();
  const params = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const baseId = useId();

  const current = {
    action: params.get('action') ?? '',
    type: params.get('type') ?? '',
    q: params.get('q') ?? '',
  };

  function apply(next: Partial<typeof current>) {
    const merged = { ...current, ...next };
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(merged)) {
      if (value) search.set(key, value);
    }
    const query = search.toString();
    startTransition(() => {
      router.replace(query ? `/?${query}` : '/', { scroll: false });
    });
  }

  return (
    <form
      className="card p-4 grid gap-4 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        apply({
          q: String(data.get('q') ?? ''),
          action: String(data.get('action') ?? ''),
          type: String(data.get('type') ?? ''),
        });
      }}
    >
      <div>
        <label htmlFor={`${baseId}-q`} className="block text-sm font-medium mb-1.5">
          Search text
        </label>
        <input
          id={`${baseId}-q`}
          name="q"
          type="search"
          defaultValue={current.q}
          placeholder="OTP, tanker, kurta…"
          className="w-full rounded-md border bg-[rgb(var(--surface))] px-3 py-2 text-sm"
        />
      </div>

      <div>
        <label htmlFor={`${baseId}-action`} className="block text-sm font-medium mb-1.5">
          Action
        </label>
        <select
          id={`${baseId}-action`}
          name="action"
          defaultValue={current.action}
          onChange={(event) => apply({ action: event.target.value })}
          className="w-full sm:w-36 rounded-md border bg-[rgb(var(--surface))] px-3 py-2 text-sm"
        >
          <option value="">All actions</option>
          {ACTIONS.map((action) => (
            <option key={action} value={action}>
              {action}
            </option>
          ))}
        </select>
      </div>

      <div>
        <label htmlFor={`${baseId}-type`} className="block text-sm font-medium mb-1.5">
          Category
        </label>
        <select
          id={`${baseId}-type`}
          name="type"
          defaultValue={current.type}
          onChange={(event) => apply({ type: event.target.value })}
          className="w-full sm:w-40 rounded-md border bg-[rgb(var(--surface))] px-3 py-2 text-sm"
        >
          <option value="">All categories</option>
          {MESSAGE_TYPES.map((type) => (
            <option key={type} value={type}>
              {type.replace('_', ' ')}
            </option>
          ))}
        </select>
      </div>

      <button
        type="submit"
        className="rounded-md border border-[rgb(var(--accent))] px-4 py-2 text-sm font-medium text-[rgb(var(--accent))] hover:bg-[rgb(var(--accent))]/10"
      >
        Apply
      </button>

      {/*
        Announced politely so the count reaches screen-reader users after a
        filter changes; without this the list silently rewrites itself.
      */}
      <p aria-live="polite" className="sm:col-span-4 text-sm text-muted">
        {isPending ? 'Filtering…' : `${resultCount} message${resultCount === 1 ? '' : 's'} shown`}
      </p>
    </form>
  );
}
