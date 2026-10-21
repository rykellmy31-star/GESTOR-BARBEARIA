#!/usr/bin/env node
/**
 * Atualiza APENAS o Worker tigu-staging existente.
 * Não altera SESSION_SECRET/MSG_ENC_KEY existentes, não cria D1/R2 e
 * não altera recursos de produção.
 */
import {readFileSync,existsSync} from "node:fs";
import {resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {stagingConfigIssues} from "./staging-config.mjs";

const ID=/^[a-f0-9]{32}$/i;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export async function updateStagingWorker({token,accountId,fetcher=fetch,exec=execFileSync,root=process.cwd()}){
  if(typeof token!=="string"||token.length<15||!ID.test(accountId||""))
    throw Error("Token staging ou Account ID ausente ou inválido.");
  const base="/accounts/"+accountId;
  async function get(path){
    const r=await fetch("https://api.cloudflare.com/client/v4"+path,{
      method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
      headers:{Authorization:"Bearer "+token,Accept:"application/json"},
    });
    if(!r.ok)throw Error("Cloudflare recusou inspeção staging ("+r.status+").");
    const j=await r.json();if(j?.success!==true)throw Error("Inventário staging indisponível.");
    return j.result;
  }
  const [dbs,media,workers]=await Promise.all([
    get(base+"/d1/database?name=tigu-staging-db"),
    get(base+"/r2/buckets?name_contains=tigu-staging-media"),
    get(base+"/workers/scripts"),
  ]);
  const d=Array.isArray(dbs)?dbs.filter(x=>x?.name==="tigu-staging-db"):[];
  const b=Array.isArray(media?.buckets)?media.buckets.filter(x=>x?.name==="tigu-staging-media"):[];
  const w=Array.isArray(workers)?workers.filter(x=>x?.id==="tigu-staging"):[];
  if(d.length!==1||!UUID.test(d[0]?.uuid||"")||b.length!==1||w.length!==1)
    throw Error("Worker/D1/R2 de homologação ausente ou ambíguo: deploy bloqueado.");
  const config=JSON.parse(readFileSync(resolve(root,"wrangler.staging.template.jsonc"),"utf8"));
  config.d1_databases[0].database_id=d[0].uuid;
  const production=JSON.parse(readFileSync(resolve(root,"wrangler.jsonc"),"utf8"));
  const issues=stagingConfigIssues(config,production);
  if(issues.length||config.name!=="tigu-staging"||config.vars.TIGU_STAGING!=="1"||
    config.triggers.crons.length||config.vars.PAYMENTS_MOCK!=="0")
    throw Error("Config do Worker staging insegura.");
  if(existsSync(resolve(root,"wrangler.staging.jsonc")))
    throw Error("Arquivo staging já presente; não sobrescrever.");
  const env={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId};
  function node(...args){exec(process.execPath,args,{cwd:root,env,stdio:"inherit"});}
  node("scripts/staging.mjs","prepare","--database-id",d[0].uuid);
  node("scripts/staging.mjs","validate");
  // Não roda migrações, nem define secrets; preserva os secrets remotos.
  node("scripts/staging.mjs","deploy");
  const response=await fetcher("https://tigu-staging.netssh3-0.workers.dev/api/health",{
    method:"GET",redirect:"error",signal:AbortSignal.timeout(20000),
  });
  const health=await response.json();
  if(response.status!==200||health?.staging!==true||health?.d1!==true||health?.r2!==true||
     !health.security?.session_secret_ready||!health.security?.encryption_key_ready||
     health.payments?.mercadopago!==false||health.whatsapp?.embedded!==false)
    throw Error("Health staging pós-deploy falhou, conferir publicação.");
  return {staging_worker:"tigu-staging",code_updated:true,existing_secrets_preserved:true,
    staging_health_verified:true,production_modified:false,migrations_applied:false,
    real_providers_enabled:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==2||process.env.GITHUB_ACTIONS!=="true"||
      process.env.GITHUB_EVENT_NAME!=="push"||
      process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
      process.env.TIGU_STAGING_UPDATE_APPROVED!=="YES")
      throw Error("Atualização de staging exige gatilho autorizado.");
    console.log("TIGU Worker update: "+JSON.stringify(await updateStagingWorker({
      token:process.env.CLOUDFLARE_STAGING_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    }),null,2));
  }catch(e){
    console.error("TIGU Worker update: "+(e instanceof Error?e.message:String(e)));
    process.exitCode=1;
  }
}
