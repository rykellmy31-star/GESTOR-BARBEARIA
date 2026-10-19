/**
 * Contrato fail-closed de homologação Tigu.
 * Não aceita bindings extras, rotas de produção ou secrets no arquivo JSON.
 */
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const permittedFields = new Set([
  "name", "main", "compatibility_date", "compatibility_flags", "vars",
  "observability", "assets", "d1_databases", "r2_buckets", "triggers",
]);
const vars = new Set(["APP_ENV", "TIGU_STAGING", "GRAPH_API_VERSION", "WHATSAPP_MOCK", "PAYMENTS_MOCK"]);
const isRecord = (x) => Boolean(x && typeof x === "object" && !Array.isArray(x));

export function stagingConfigIssues(config, original) {
  const issues = [];
  if (!isRecord(config)) return ["configuração inexistente"];
  const fail = (condition, message) => { if (!condition) issues.push(message); };

  fail(Object.keys(config).every(k => permittedFields.has(k)), "recursos ou rotas extras não são permitidos");
  fail(config.name === "tigu-staging", "nome do Worker deve ser tigu-staging");
  fail(config.main === "api/index.ts", "entrypoint do Worker inesperado");
  fail(config.compatibility_date === "2025-01-01", "compatibility_date inesperada");
  fail(Array.isArray(config.compatibility_flags) &&
    config.compatibility_flags.length === 1 &&
    config.compatibility_flags[0] === "nodejs_compat", "flags adicionais não permitidas");
  fail(isRecord(config.vars) && Object.keys(config.vars).length === vars.size &&
    Object.keys(config.vars).every(k => vars.has(k)), "variáveis não permitidas ou ausentes");
  fail(config.vars?.APP_ENV === "production" && config.vars?.TIGU_STAGING === "1" &&
    config.vars?.WHATSAPP_MOCK === "1" && config.vars?.PAYMENTS_MOCK === "0" &&
    config.vars?.GRAPH_API_VERSION === "v23.0", "flags de isolamento da homologação inválidas");
  fail(config.observability?.enabled === true, "observabilidade deve estar ligada");

  const assets = config.assets;
  fail(isRecord(assets) && Object.keys(assets).length === 4 &&
    assets.directory === "./dist" && assets.binding === "ASSETS" &&
    assets.not_found_handling === "single-page-application" &&
    Array.isArray(assets.run_worker_first) &&
    assets.run_worker_first.length === 2 &&
    assets.run_worker_first.includes("/api/*") &&
    assets.run_worker_first.includes("/uploads/*"), "assets ou roteamento de API inseguros");

  const databases = config.d1_databases;
  const db = Array.isArray(databases) && databases.length === 1 ? databases[0] : null;
  fail(Boolean(db && Object.keys(db).length === 4 &&
    db.binding === "DB" && db.database_name === "tigu-staging-db" &&
    uuid.test(db.database_id || "") &&
    db.database_id !== original?.d1_databases?.[0]?.database_id &&
    db.migrations_dir === "migrations"), "D1 deve ser exclusivamente tigu-staging-db");

  const buckets = config.r2_buckets;
  const bucket = Array.isArray(buckets) && buckets.length === 1 ? buckets[0] : null;
  fail(Boolean(bucket && Object.keys(bucket).length === 2 &&
    bucket.binding === "MEDIA" && bucket.bucket_name === "tigu-staging-media" &&
    bucket.bucket_name !== original?.r2_buckets?.[0]?.bucket_name),
    "R2 deve ser exclusivamente tigu-staging-media");

  fail(isRecord(config.triggers) && Object.keys(config.triggers).length === 1 &&
    Array.isArray(config.triggers.crons) && config.triggers.crons.length === 0,
    "cron é proibido na homologação");

  return issues;
}
