import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        g: {
          bg:     '#0A0A0F',
          card:   '#12121A',
          hover:  '#1A1A25',
          subtle: '#1E1E2A',
          border: '#2A2A3A',
          bright: '#3A3A4A',
        },
        accent: {
          DEFAULT: '#00E5A0',
        },
        txt: {
          DEFAULT:   '#E8E8ED',
          secondary: '#8888A0',
          muted:     '#55556A',
        },
      },
    },
  },
  plugins: [],
};
export default config;
