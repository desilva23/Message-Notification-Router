/**
 * Next.js configuration.
 *
 * Security headers are set here rather than in middleware so that they apply to
 * static assets as well as rendered routes. The CSP is deliberately strict: the
 * app ships no third-party scripts and makes no cross-origin requests from the
 * browser, so everything can stay same-origin.
 */

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // Media files live under dataset/media and are copied into public/media at
  // build time by scripts/prepare-public-media.ts.
  outputFileTracingIncludes: {
    '/api/**': ['./dataset/**'],
  },

  async headers() {
    const csp = [
      "default-src 'self'",
      // Next.js injects a small inline bootstrap script; styles are emitted inline
      // by the framework in dev. No external script origins are permitted.
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "media-src 'self'",
      "font-src 'self'",
      "connect-src 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "object-src 'none'",
      'upgrade-insecure-requests',
    ].join('; ');

    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()' },
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
