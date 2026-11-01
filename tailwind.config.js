/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans:    ['DM Sans', 'sans-serif'],
        display: ['Space Grotesk', 'sans-serif'],
        mono:    ['JetBrains Mono', 'Menlo', 'monospace'],
      },
      colors: {
        reflow: {
          cobalt: '#1a50c8',
          'cobalt-hover': '#1244b0',
          mint:   '#1a7a58',
          'mint-bg': 'rgba(26,122,88,0.08)',
          ink:    '#1a1614',
          muted:  '#6b6460',
          surface: 'rgba(255,255,255,0.75)',
        },
      },
      borderRadius: {
        '4xl': '2rem',
      },
    },
  },
  plugins: [],
}
