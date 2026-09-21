/**
 * Design tokens for the panel's NEXUS-style theme.
 *
 * The whole UI is driven from here: every page already speaks in `brand-*`,
 * `slate-*` and the accent families below, so re-pointing these palettes
 * re-skins the entire app without touching page markup.
 *
 *   brand / lime   → the single accent (buttons, active nav, live chips)
 *   slate          → green-tinted near-black surfaces + muted text
 *   green/emerald  → "success" states, in the same lime family
 *   blue/cyan/teal/indigo/purple → secondary accents, folded into the
 *                     monochrome green scale so nothing reads as off-theme
 *   error / warning → kept semantic (red / amber) so failures stay visible
 */
const lime = {
  50: '#f6ffe3',
  100: '#ecffc4',
  200: '#dcfb92',
  300: '#c6f45b',
  400: '#ade62f',
  500: '#93c918',
  600: '#74a012',
  700: '#597c13',
  800: '#48631a',
  900: '#3c521b',
}

const moss = {
  200: '#c9e8d4',
  300: '#9ed4b0',
  400: '#6fbf8a',
  500: '#4aa06b',
  600: '#357a52',
  700: '#2a5f42',
}

const surface = {
  50: '#f4faf4',
  100: '#e6f1e6',
  200: '#c8dcc9',
  300: '#a3bda5',
  400: '#7d9a80',
  500: '#5d7a61',
  600: '#455d49',
  700: '#2c3a2f',
  800: '#1b261d',
  900: '#111a13',
  950: '#0a0f0b',
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: lime,
        lime,
        // Success states follow the accent family instead of a separate green.
        green: lime,
        emerald: lime,
        // Secondary accents collapse into one muted green so the theme stays
        // monochrome — no leftover blues or purples anywhere.
        blue: moss,
        sky: moss,
        cyan: moss,
        teal: moss,
        indigo: moss,
        violet: moss,
        purple: moss,
        slate: surface,
        error: {
          300: '#fda4af',
          400: '#fb7185',
          500: '#f43f5e',
        },
        warning: {
          300: '#fcd34d',
          400: '#fbbf24',
          500: '#f59e0b',
        },
      },
      fontFamily: {
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      borderRadius: {
        '4xl': '1.75rem',
      },
      keyframes: {
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-up': {
          from: { opacity: '0', transform: 'translateY(16px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        'slide-in': {
          from: { opacity: '0', transform: 'translateX(-12px)' },
          to: { opacity: '1', transform: 'translateX(0)' },
        },
        float: {
          '0%, 100%': { transform: 'translateY(0)' },
          '50%': { transform: 'translateY(-14px)' },
        },
        shimmer: {
          from: { backgroundPosition: '200% 0' },
          to: { backgroundPosition: '-200% 0' },
        },
        'pulse-glow': {
          '0%, 100%': { boxShadow: '0 0 18px rgba(198, 244, 91, 0.25)' },
          '50%': { boxShadow: '0 0 34px rgba(198, 244, 91, 0.5)' },
        },
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.85)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 0.3s ease-out both',
        'slide-up': 'slide-up 0.4s ease-out both',
        'slide-in': 'slide-in 0.3s ease-out both',
        float: 'float 6s ease-in-out infinite',
        'pulse-glow': 'pulse-glow 2.4s ease-in-out infinite',
        'pulse-dot': 'pulse-dot 1.8s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
