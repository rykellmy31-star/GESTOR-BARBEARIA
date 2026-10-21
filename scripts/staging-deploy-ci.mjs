#!/usr/bin/env node
/**
 * Publica somente tigu-staging em Cloudflare com D1/R2 de homologação.
 * Executado UMA vez após autenticação, suite local e guardas de CI.
 * Cria SESSION_SECRET e MSG_ENC_KEY aleatórios, guardados como Worker secrets.
 * Não publica a produção, não cria custom domains, não ativa Pix nem Meta.
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { stagingConfigIssues } from "./staging-config.mjs";

const API = "https://api.cloudflare.com/client/v4";
const ID = /^[0-9a-f]{32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const D1_NAME = "tigu-staging-db";
const R2_NAME = "tigu-staging-media";
const WORKER = "tigu-staging";

export function inspectStagingInventory(d1, r2, workers) {
  if (!Array.isArray(d1) || !Array.isArray(r2?.buckets) || !Array.isArray(workers))
    throw Error("Formato inesperado de inventário Cloudflare.");
  const matches = (arr, prop, expected) => arr.filter(x => x?.[prop] === expected);
  const db = matches(d1, "name", D1_NAME);
  const bucket = matches(r2.buckets, "name", R2_NAME);
  const worker = matches(workers, "id", WORKER);
  if (db.length !== 1 || !UUID.test(db[0]?.uuid || ""))
    throw Error("D1 de homologação ausente ou ambíguo: não implantar.");
  if (bucket.length !== 1)
    throw Error("R2 de homologação ausente ou ambíguo: não implantar.");
  if (worker.length)
    throw Error("Worker tigu-staging já existe; não sobrescrever remotamente sem análise.");
  return { databaseId: db[0].uuid, database: D1_NAME, bucket: R2_NAME, worker: WORKER };
}

export function stagingDeploymentPlan(databaseId, template, production) {
  if (!UUID.test(databaseId || "")) throw Error("D1 staging não possui UUID válido.");
  const cfg = structuredClone(template);
  if (cfg?.d1_databases?.[0]) cfg.d1_databases[0].database_id = databaseId;
  const problems = stagingConfigIssues(cfg, production);
  if (problems.length) throw Error("Deploy de staging bloqueado: " + problems.join("; "));
  return cfg;
}

export async function deployTiguStaging({
  token, accountId, fetcher = fetch, run = execFileSync, root = process.cwd(),
}) {
  if (typeof token !== "string" || token.length < 15)
    throw Error("CLOUDFLARE_STAGING_TOKEN ausente.");
  if (!ID.test(accountId || "")) throw Error("CLOUDFLARE_ACCOUNT_ID inválido.");
  const prefix = "/accounts/" + accountId;
  async function get(path) {
    const response = await fetcher(API + path,{
      method:"GET",headers:{Authorization:"Bearer "+token,Accept:"application/json"},
      redirect:"error",signal:AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("Cloudflare negou inventário ("+response.status+").");
    const json = await response.json();
    if (json?.success !== true) throw Error("Cloudflare recusou leitura de inventário.");
    return json.result;
  }
  const inventory = inspectStagingInventory(
    await get(prefix+"/d1/database?name="+D1_NAME),
    await get(prefix+"/r2/buckets?name_contains="+R2_NAME),
    await get(prefix+"/workers/scripts")
  );
  const template=JSON.parse(readFileSync(resolve(root,"wrangler.staging.template.jsonc"),"utf8"));
  const production=JSON.parse(readFileSync(resolve(root,"wrangler.jsonc"),"utf8"));
  const planned=stagingDeploymentPlan(inventory.databaseId,template,production);
  if (existsSync(resolve(root,"wrangler.staging.jsonc")))
    throw Error("Config staging já existe no runner; não sobrescrever.");
  // Validar o plano ANTES de executar qualquer migração ou publicação.
  if (planned.name !== WORKER || planned.vars.TIGU_STAGING !== "1" ||
      planned.triggers.crons.length || planned.vars.PAYMENTS_MOCK !== "0")
    throw Error("Isolamento de homologação não validado.");

  const env={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId};
  const node=(...args)=>run(process.execPath,args,{cwd:root,env,stdio:"inherit"});
  // staging.mjs checa o mesmo contrato contra o Worker de produção.
  node("scripts/staging.mjs","prepare","--database-id",inventory.databaseId);
  node("scripts/staging.mjs","validate");
  // A Cloudflare captura um backup antes de cada migration remota D1.
  node("scripts/staging.mjs","migrate");
  // Build e Worker são publicados com o nome fixo tigu-staging.
  node("scripts/staging.mjs","deploy");

  const config=resolve(root,"wrangler.staging.jsonc");
  // Never echo or commit secrets: one-time crypto-random values, persisted
  // ONLY in Cloudflare. A future update must preserve these same secrets.
  for(const name of ["SESSION_SECRET","MSG_ENC_KEY"]) {
    run("npx",["wrangler","secret","put",name,"--config",config],{
      cwd:root,env,input:randomBytes(48).toString("hex")+"\n",
      stdio:["pipe","inherit","inherit"],
    });
  }
  const scripts=await get(prefix+"/workers/scripts");
  if (!Array.isArray(scripts) || !scripts.some(x=>x?.id===WORKER))
    throw Error("Worker não aparece no inventário depois do deploy.");
  return {
    staging_worker: WORKER,
    d1_bound: true,r2_bound: true,
    secrets_configured: ["SESSION_SECRET","MSG_ENC_KEY"],
    staging_deployed: true,
    production_modified:false,
    provider_integrations_live:false,
    backups_restored:false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 2 ||
      process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_EVENT_NAME !== "push" ||
      process.env.GITHUB_REF !== "refs/heads/audit/tigu-primeira-validacao" ||
      process.env.TIGU_STAGING_DEPLOY_APPROVED !== "YES")
      throw Error("Deploy TIGU bloqueado: exige push autorizado no Actions.");
    const result=await deployTiguStaging({
      token:process.env.CLOUDFLARE_STAGING_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    });
    console.log("TIGU staging publicado:\n"+JSON.stringify(result,null,2));
    console.log("Ainda faltam testes online por URL, validação de backup e integrações externas.");
  }catch(err){
    console.error("TIGU staging: "+(err instanceof Error ? err.message : String(err)));
    process.exitCode=1;
  }
}
