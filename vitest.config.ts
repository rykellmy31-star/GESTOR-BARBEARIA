import { defineWorkersConfig } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig({
  test: {
    isolate: false,
    testTimeout: 30000,
    include: ["tests/**/*.test.ts"],
    poolOptions: {
      workers: {
        singleWorker: true,
        // storage compartilhado entre testes (o pool faria snapshot por teste)
        isolatedStorage: false,
        wrangler: { configPath: "./wrangler.jsonc" },
      },
    },
  },
});
