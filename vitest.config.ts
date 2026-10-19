import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
  test: {
    isolate: false,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 30000,
    include: ["tests/**/*.test.ts"],
  },
});
