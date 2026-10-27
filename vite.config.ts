import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// O frontend roda no Vite; a API é servida pelo `wrangler dev` (porta 8787)
// e encaminhada pelo proxy abaixo — em produção o mesmo Worker serve tudo.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
    },
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    strictPort: true,
    allowedHosts: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", changeOrigin: true },
      "/uploads": { target: "http://127.0.0.1:8787", changeOrigin: true },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
    chunkSizeWarningLimit: 900,
  },
});
