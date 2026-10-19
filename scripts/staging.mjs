#!/usr/bin/env node
/**
 * Prepara e valida um Worker de homologação isolado, sem secrets no Git.
 * Uso: node scripts/staging.mjs prepare --database-id <D1_UUID>
 *      node scripts/staging.mjs migrate|deploy|super [--email ...]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";
import { stagingConfigIssues } from "./staging-config.mjs";

const [action = "", ...args] = process.argv.slice(2);
const root = process.cwd();
const path = resolve(root, "wrangler.staging.jsonc");
const template = resolve(root, "wrangler.staging.template.jsonc");
const databaseName = "tigu-staging-db";
const getArg = (name) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : null; };
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const die = (message) => { console.error("✖ Homologação Tigu: " + message); process.exit(1); };

if (action === "prepare") {
  const id = getArg("--database-id");
  if (!id || !guid.test(id)) die("informe o UUID do D1 de HOMOLOGAÇÃO com --database-id.");
  if (existsSync(path)) die("wrangler.staging.jsonc já existe; confirme seu conteúdo antes de substituí-lo.");
  const config = JSON.parse(readFileSync(template, "utf8"));
  config.d1_databases[0].database_id = id;
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  console.log("✔ Configuração criada: wrangler.staging.jsonc (ignorada pelo Git).");
  console.log("  Próximo passo: rode 'npm run staging:validate'.");
  process.exit(0);
}

if (!existsSync(path)) die("configure primeiro: npm run staging:prepare -- --database-id UUID_DO_D1_TESTE.");
const config = JSON.parse(readFileSync(path, "utf8"));
const original = JSON.parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
const issues = stagingConfigIssues(config, original);
if (issues.length) die("Configuração insegura: " + issues.join("; ") + ". Nada foi executado.");
console.log("✔ Worker, D1, R2 e bloqueios de homologação conferidos.");
if (action === "validate") process.exit(0);

const configArg = ["--config", path];
const run = (command) => {
  console.log("Executando comando de homologação (recursos Tigu separados)…");
  execFileSync("npx", ["wrangler", ...command, ...configArg], { stdio: "inherit" });
};
if (action === "migrate") {
  run(["d1", "migrations", "apply", databaseName, "--remote"]);
} else if (action === "deploy") {
  // Compila com a mesma rota API + Assets do Pages, porém no Worker separado.
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
  run(["deploy"]);
} else if (action === "super") {
  execFileSync("node", ["scripts/create-super.mjs", "--remote",
    "--database", databaseName, "--config", path, ...args], { stdio: "inherit" });
} else {
  die("operação desconhecida: use prepare, validate, migrate, deploy ou super.");
}
