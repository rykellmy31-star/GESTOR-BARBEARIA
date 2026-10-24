#!/usr/bin/env node
// Zera o D1 LOCAL (apaga estado do wrangler dev/.wrangler) e reaplica migrations.
// Uso: npm run db:reset:local
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
try {
  rmSync(path.join(root, ".wrangler/state"), { recursive: true, force: true });
  console.log("✔ Estado local removido (.wrangler/state)");
  execFileSync("npx", ["wrangler", "d1", "migrations", "apply", "tigu-db", "--local"], { stdio: "inherit", cwd: root });
  console.log("✔ Migrations reaplicadas. Rode 'npm run setup:super && npm run db:seed:local' para dados de demonstração.");
} catch (e) {
  console.error("Falha:", e.message);
  process.exit(1);
}
