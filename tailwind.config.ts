import type { Config } from 'tailwindcss';

export default {
  content: ['./src/**/*.{ts,tsx}'],
  darkMode: 'media',
  theme: {
    extend: {
      colors: {
        surface: 'rgb(var(--surface) / <alpha-value>)',
        raised: 'rgb(var(--raised) / <alpha-value>)',
        ink: 'rgb(var(--ink) / <alpha-value>)',
        muted: 'rgb(var(--muted) / <alpha-value>)',
        line: 'rgb(var(--line) / <alpha-value>)',
        accent: 'rgb(var(--accent) / <alpha-value>)',
        notify: 'rgb(var(--notify) / <alpha-value>)',
        digest: 'rgb(var(--digest) / <alpha-value>)',
        mute: 'rgb(var(--mute) / <alpha-value>)',
      },
    },
  },
  plugins: [],
} satisfies Config;
