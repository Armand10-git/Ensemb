import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

/**
 * Thème dérivé de docs/ux/tokens.md. L'échelle "brand" (verte) est le thème par défaut ;
 * la couleur du tenant remplace primary/brand-500 au runtime (§17, standards.md règle 9) —
 * non câblé dans cette itération, mais la structure de tokens le permet sans refonte.
 */
const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#F0FBF4',
          100: '#DCF5E3',
          200: '#BAEAC8',
          300: '#8ED9AC',
          400: '#55C17D',
          500: '#2FA75E',
          600: '#1F8A4B',
          700: '#196F3D',
          800: '#155A32',
          900: '#154A2C',
          950: '#09291A',
        },
        amber: {
          50: '#FFFBEB',
          200: '#FDE68A',
          600: '#B45309',
          700: '#92400E',
        },
        danger: {
          50: '#FEF2F2',
          200: '#FECACA',
          600: '#B91C1C',
          700: '#991B1B',
        },
        info: {
          50: '#F0F9FF',
          200: '#BAE6FD',
          600: '#0369A1',
          700: '#075985',
        },
      },
      fontFamily: {
        display: ['"Bricolage Grotesque"', 'system-ui', 'sans-serif'],
        sans: ['"Instrument Sans"', 'system-ui', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'monospace'],
      },
      borderRadius: {
        field: '8px',
        card: '12px',
      },
      boxShadow: {
        1: '0 1px 2px 0 rgb(0 0 0 / 0.05), 0 1px 3px 0 rgb(0 0 0 / 0.06)',
        2: '0 4px 12px -2px rgb(0 0 0 / 0.10), 0 2px 6px -2px rgb(0 0 0 / 0.06)',
      },
      keyframes: {
        'pulse-once': {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.4' },
        },
      },
      animation: {
        'pulse-once': 'pulse-once 0.6s ease-out 1',
      },
    },
  },
  plugins: [animate],
};

export default config;
