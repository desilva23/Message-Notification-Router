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

  // The CSV fallback reads dataset/ from disk at request time, but the paths are
  // built at runtime (join(cwd, 'dataset', file)), so Next's static import
  // tracing cannot see them and would ship a serverless bundle without them.
  // Every route needs the include, not just '/api/**': this app has no API
  // routes, and '/' renders dynamically because it filters on searchParams.
  //
  // Only the files actually read on the server are listed. dataset/media is
  // deliberately excluded — it is 11 MB, and scripts/prepare-public-media.ts
  // copies it into public/ at build time, so it is served as a static asset
  // rather than read by a function.
  outputFileTracingIncludes: {
    '/**': ['./dataset/*.csv', './dataset/media_analysis.json'],
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
