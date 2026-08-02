import Link from 'next/link';

export const metadata = { title: 'Not found' };

export default function NotFound() {
  return (
    <div className="max-w-lg space-y-4">
      <h1 className="text-2xl font-semibold tracking-tight">Message not found</h1>
      <p className="text-muted">
        No routed message matches that id. It may have been renamed, or it may not be part of the
        routing set.
      </p>
      <Link href="/" className="inline-block text-[rgb(var(--accent))] hover:underline">
        ← Back to triage
      </Link>
    </div>
  );
}
