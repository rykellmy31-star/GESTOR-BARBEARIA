#!/usr/bin/env node
/**
 * Gate local para deploy e D1 remoto. Nao acessa rede; homologacao real
 * de credenciais, provedores e pagamentos permanece obrigatoria.
 */
import {readFileSync} from "node:fs";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";

const isRecord = x => Boolean(x) && typeof x === "object" && !Array.isArray(x);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const enabled = v => v===true || v===1 || typeof v==="string" && /^(1|true|on|yes)$/i.test(v.trim());

export function productionConfigIssues(config) {
  if (!isRecord(config)) return ["Configuracao do Worker ausente ou invalida"];
  const errors = [];
  const require = (pass, reason) => {if(!pass) errors.push(reason)};
  require(config.name==="tigu-production","Worker de producao inesperado");
  require(config.main==="api/index.ts","Entrypoint inesperado");
  require(typeof config.compatibility_date==="string" && /^\d{4}-\d{2}-\d{2}$/.test(config.compatibility_date),"compatibility_date invalida");
  require(Array.isArray(config.compatibility_flags) && config.compatibility_flags.includes("nodejs_compat"),"nodejs_compat obrigatorio");
  const vars=isRecord(config.vars)?config.vars:{};
  require(vars.APP_ENV==="production","APP_ENV deve ser production");
  require(!enabled(vars.PAYMENTS_MOCK),"Pagamentos simulados proibidos em producao");
  require(!enabled(vars.WHATSAPP_MOCK),"WhatsApp simulado proibido em producao");
  require(!enabled(vars.TIGU_STAGING),"TIGU_STAGING proibido em producao");
  require(!Object.keys(vars).some(k=>/(SECRET|PASSWORD|ACCESS_TOKEN|PRIVATE_KEY|MSG_ENC_KEY|API_KEY)/i.test(k)),
    "Credenciais nao devem estar em vars publicas: usar wrangler secret put");
  const d=Array.isArray(config.d1_databases)&&config.d1_databases.length===1?config.d1_databases[0]:null;
  require(isRecord(d) && d.binding==="DB" && d.database_name==="tigu-production-db" &&
    typeof d.database_id==="string" && uuid.test(d.database_id) &&
    d.database_id!=="00000000-0000-0000-0000-000000000000" &&
    d.migrations_dir==="migrations","D1 de producao invalido");
  const b=Array.isArray(config.r2_buckets)&&config.r2_buckets.length===1?config.r2_buckets[0]:null;
  require(isRecord(b) && b.binding==="MEDIA" && b.bucket_name==="tigu-production-media",
    "R2 de producao invalido");
  const a=config.assets;
  require(isRecord(a) && a.directory==="./dist" && a.binding==="ASSETS" &&
    a.not_found_handling==="single-page-application" &&
    Array.isArray(a.run_worker_first) &&
    a.run_worker_first.includes("/api/*") && a.run_worker_first.includes("/uploads/*"),
    "Rotas Worker /api/* e /uploads/* devem ter precedencia");
  require(isRecord(config.triggers) && Array.isArray(config.triggers.crons) && config.triggers.crons.length>0,
    "Cron de producao ausente");
  return errors;
}

export function inspectProductionConfig(root=process.cwd()) {
  try {
    return productionConfigIssues(JSON.parse(readFileSync(resolve(root,"wrangler.jsonc"),"utf8")));
  } catch {return ["wrangler.jsonc ausente ou JSON invalido"];}
}

if (process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  const errors=inspectProductionConfig();
  if(errors.length){
    console.error("BLOQUEADO: nao executar deploy ou migracao remota:");
    for(const e of errors)console.error(" - "+e);
    process.exitCode=1;
  } else {
    console.log("Preflight local aprovado. Secrets, provedores e operacoes em producao NAO foram homologados.");
  }
}
