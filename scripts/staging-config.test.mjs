import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stagingConfigIssues } from "./staging-config.mjs";

const template = JSON.parse(readFileSync(new URL("../wrangler.staging.template.jsonc", import.meta.url), "utf8"));
const production = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const safe = () => {
  const config = structuredClone(template);
  config.d1_databases[0].database_id = "00000000-0000-4000-8000-000000000001";
  return config;
};

test("configuração isolada do Tigu aceita apenas o Worker de testes", () => {
  assert.deepEqual(stagingConfigIssues(safe(), production), []);
});

const dangerous = [
  ["outra branch / Worker", x => { x.name = "tigu-platform"; }],
  ["rota de domínio real", x => { x.routes = [{ pattern: "tigu.com.br/*" }]; }],
  ["worker em zona externa", x => { x.zone_id = "identificador-real"; }],
  ["binding adicional D1", x => { x.d1_databases.push({ binding: "PROD_DB", database_name: "tigu-db", database_id: "00000000-0000-4000-8000-000000000002" }); }],
  ["binding adicional R2", x => { x.r2_buckets.push({ binding: "OUTRO", bucket_name: "tigu-media" }); }],
  ["R2 apontando para produção", x => { x.r2_buckets[0].bucket_name = "tigu-media"; }],
  ["variável com token", x => { x.vars.MP_ACCESS_TOKEN = "NUNCA"; }],
  ["outra flag com ambiente não isolado", x => { x.vars.TIGU_STAGING = "0"; }],
  ["pagamentos de teste ativos", x => { x.vars.PAYMENTS_MOCK = "1"; }],
  ["novo cron", x => { x.triggers.crons.push("*/1 * * * *"); }],
  ["API não interceptada pelo Worker", x => { x.assets.run_worker_first = ["/uploads/*"]; }],
  ["D1 inexistente", x => { x.d1_databases[0].database_id = "REPLACE_WITH_STAGING_D1"; }],
  ["migrations inconsistentes", x => { x.d1_databases[0].migrations_dir = "../other"; }],
  ["secret embutido em configuração", x => { x.vars.SESSION_SECRET = "senha"; }],
  ["binding extra via KV", x => { x.kv_namespaces = [{ binding: "DADOS" }]; }],
];

for (const [description, change] of dangerous) {
  test("rejeita " + description, () => {
    const x = safe();
    change(x);
    assert.ok(stagingConfigIssues(x, production).length > 0);
  });
}

test("recusa compartilhar o mesmo identificador D1 com a produção", () => {
  const original = structuredClone(production);
  const x = safe();
  original.d1_databases[0].database_id = x.d1_databases[0].database_id;
  assert.ok(stagingConfigIssues(x, original).length > 0);
});
