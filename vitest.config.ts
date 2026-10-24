import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    // Cada arquivo precisa de banco e módulos próprios, independentemente da ordem.
    isolate: true,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
    include: ["tests/**/*.test.ts", "src/lib/owner-welcome.test.ts"],
  },
});
