/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Cores dinâmicas: o painel administrativo pode alterá-las em /admin/configuracoes
        // via variáveis CSS (--c-gold, --c-ink, --c-panel, --c-line).
        gold: {
          DEFAULT: "var(--c-gold, #d4af37)",
          soft: "var(--c-gold-soft, rgba(212,175,55,0.14))",
        },
        ink: {
          DEFAULT: "var(--c-ink, #0a0a0c)",
          soft: "var(--c-ink-soft, #111115)",
        },
        panel: "var(--c-panel, #16161c)",
        line: "var(--c-line, #26262f)",
      },
      fontFamily: {
        display: ['"Playfair Display"', "Georgia", "serif"],
        sans: ['"Inter"', "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
      },
      boxShadow: {
        gold: "0 0 0 1px rgba(212,175,55,0.25), 0 20px 60px -20px rgba(212,175,55,0.15)",
        card: "0 24px 70px -30px rgba(0,0,0,0.85)",
      },
      keyframes: {
        "fade-up": {
          "0%": { opacity: "0", transform: "translateY(24px)" },
          "100%": { opacity: "1", transform: "translateY(0)" },
        },
        shimmer: {
          "0%": { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition: "200% 0" },
        },
        "scale-in": {
          "0%": { opacity: "0", transform: "scale(0.96)" },
          "100%": { opacity: "1", transform: "scale(1)" },
        },
        "pulse-dot": {
          "0%,100%": { opacity: "1" },
          "50%": { opacity: "0.35" },
        },
      },
      animation: {
        "fade-up": "fade-up 0.7s cubic-bezier(0.22,1,0.36,1) both",
        "scale-in": "scale-in 0.25s ease-out both",
        "pulse-dot": "pulse-dot 1.6s ease-in-out infinite",
      },
    },
  },
  plugins: [],
};
