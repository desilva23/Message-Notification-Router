import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'Message Notification Router',
    template: '%s · Message Notification Router',
  },
  description:
    'Multimodal routing of WhatsApp messages into notify, digest and mute — with the full signal trace behind every decision.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // No maximum-scale or user-scalable=no: capping zoom breaks the page for
  // anyone who needs to magnify it.
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#fafaf9' },
    { media: '(prefers-color-scheme: dark)', color: '#0c0c0e' },
  ],
};

const NAV = [
  { href: '/', label: 'Triage' },
  { href: '/evaluation', label: 'Evaluation' },
  { href: '/how-it-works', label: 'How it works' },
] as const;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {/* First focusable element on the page, so keyboard users can bypass
            the navigation rather than tabbing through it on every route. */}
        <a href="#main" className="skip-link">
          Skip to main content
        </a>

        <div className="min-h-screen flex flex-col">
          <header className="sticky top-0 z-40 border-b bg-[rgb(var(--surface))]/95 backdrop-blur">
            <div className="mx-auto max-w-6xl px-4 sm:px-6 h-16 flex items-center justify-between gap-4">
              <Link href="/" className="font-semibold tracking-tight text-[0.95rem] shrink-0">
                Notification Router
              </Link>
              {/* Scrolls rather than wraps on narrow screens: a three-line
                  "How it works" pushes the header to twice its height and
                  shoves the page content off the first viewport. */}
              <nav aria-label="Primary" className="min-w-0 overflow-x-auto">
                <ul className="flex items-center gap-1 sm:gap-2 text-sm">
                  {NAV.map((item) => (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        className="block whitespace-nowrap px-2 sm:px-3 py-2 rounded-md text-muted hover:text-ink hover:bg-[rgb(var(--raised))]"
                      >
                        {item.label}
                      </Link>
                    </li>
                  ))}
                </ul>
              </nav>
            </div>
          </header>

          <main id="main" className="flex-1 mx-auto w-full max-w-6xl px-4 sm:px-6 py-8">
            {children}
          </main>

          <footer className="border-t mt-12">
            <div className="mx-auto max-w-6xl px-4 sm:px-6 py-6 text-sm text-muted">
              <p>
                Built for HackerRank Orchestrate. Routes a synthetic WhatsApp dataset; no real
                personal data is processed.
              </p>
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
