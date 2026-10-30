#!/usr/bin/env node
/**
 * TIGU — preflight de produção SEM ESCRITA. Nunca cria Worker, D1, R2,
 * modifica DNS, executa migração, usa gateways ou revela dados pessoais.
 * A conta de staging já configurada é utilizada APENAS para inventário GET.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API="https://api.cloudflare.com/client/v4";
const ACCOUNT_ID=/^[a-f0-9]{32}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const STAGING={
  worker:"tigu-staging",d1:"tigu-staging-db",r2:"tigu-staging-media",
};
export const PRODUCTION={
  worker:"tigu-production",d1:"tigu-production-db",r2:"tigu-production-media",
};

const record=v=>Boolean(v&&typeof v==="object"&&!Array.isArray(v));
export function productionTemplateIssues(c) {
  const issues=[];
  const check=(ok,reason)=>{if(!ok)issues.push(reason)};
  if(!record(c))return ["Template de produção ausente."];
  const props=new Set(["name","main","compatibility_date","compatibility_flags",
    "vars","observability","assets","d1_databases","r2_buckets","triggers"]);
  check(Object.keys(c).every(k=>props.has(k)), "Rotas/domínios ou campos extras proibidos.");
  check(c.name===PRODUCTION.worker,"Nome do Worker de produção deve ser isolado.");
  check(c.main==="api/index.ts","Entrypoint inesperado.");
  check(c.compatibility_date==="2025-01-01"&&
    JSON.stringify(c.compatibility_flags)==='["nodejs_compat"]',"Config de compatibilidade inesperada.");
  const v=c.vars;
  const keys=["APP_ENV","TIGU_STAGING","WHATSAPP_MOCK",
    "PAYMENTS_MOCK","MERCHANT_PIX_ENABLED"];
  check(record(v)&&Object.keys(v).length===keys.length&&
    keys.every(k=>Object.hasOwn(v,k))&&v.APP_ENV==="production"&&
    v.TIGU_STAGING==="0"&&
    v.WHATSAPP_MOCK==="0"&&v.PAYMENTS_MOCK==="0"&&
    v.MERCHANT_PIX_ENABLED==="0",
    "Flags de produção: sem mock, checkout de terceiros desligado e sem segredos.");
  check(record(c.observability)&&c.observability.enabled===true,
    "Observabilidade obrigatória.");
  const a=c.assets;
  check(record(a)&&a.directory==="./dist"&&a.binding==="ASSETS"&&
    a.not_found_handling==="single-page-application"&&
    JSON.stringify(a.run_worker_first)==='["/api/*","/uploads/*"]',
    "Assets/rotas API inesperados.");
  const d=Array.isArray(c.d1_databases)&&c.d1_databases.length===1?
    c.d1_databases[0]:null;
  check(record(d)&&d.binding==="DB"&&d.database_name===PRODUCTION.d1&&
    d.migrations_dir==="migrations"&&
    d.database_id==="REPLACE_ONLY_AFTER_CREATING_ISOLATED_PRODUCTION_D1",
    "D1 de produção separado obrigatório, template não pode ser publicado.");
  const b=Array.isArray(c.r2_buckets)&&c.r2_buckets.length===1?
    c.r2_buckets[0]:null;
  check(record(b)&&b.binding==="MEDIA"&&b.bucket_name===PRODUCTION.r2,
    "R2 de produção separado obrigatório.");
  check(record(c.triggers)&&
    JSON.stringify(c.triggers.crons)==="[]","Nenhum cron de produção antes da homologação.");
  return issues;
}
export function inspectResources(dbsStaging,dbsProduction,r2Staging,r2Production,workers) {
  if(!Array.isArray(dbsStaging)||!Array.isArray(dbsProduction)||
     !Array.isArray(r2Staging?.buckets)||!Array.isArray(r2Production?.buckets)||
     !Array.isArray(workers))throw Error("Inventário Cloudflare inconsistente.");
  const stageDb=dbsStaging.filter(x=>x?.name===STAGING.d1);
  const stageR2=r2Staging.buckets.filter(x=>x?.name===STAGING.r2);
  const stageWorker=workers.filter(x=>x?.id===STAGING.worker);
  if(stageDb.length!==1||!UUID.test(stageDb[0]?.uuid||"")||
     stageR2.length!==1||stageWorker.length!==1)
    throw Error("Worker/D1/R2 de homologação não puderam ser comprovados. Parar.");
  const prodDb=dbsProduction.filter(x=>x?.name===PRODUCTION.d1);
  const prodR2=r2Production.buckets.filter(x=>x?.name===PRODUCTION.r2);
  const prodWorker=workers.filter(x=>x?.id===PRODUCTION.worker);
  if(prodDb.length>1||prodR2.length>1||prodWorker.length>1)
    throw Error("Recursos duplicados de produção. Não prosseguir.");
  if(prodDb.length===1&&!UUID.test(prodDb[0]?.uuid||""))
    throw Error("D1 de produção com identificação inesperada.");
  if(prodDb.length+prodR2.length+prodWorker.length>0){
    const kinds=[prodDb.length>0&&"D1",prodR2.length>0&&"R2",prodWorker.length>0&&"Worker"].filter(Boolean);
    // Reporta somente categorias esperadas; não revela IDs, dados, segredos ou endpoints.
    throw Error("Já existem recursos de produção ("+kinds.join(", ")+"): requer inspeção antes de qualquer provisionamento.");
  }
  return {staging_verified:true,production_targets_absent:true,
    safe_to_prepare:true,production_activated:false};
}
export async function auditProductionResources({
  token,accountId,fetcher=fetch,root=resolve(import.meta.dirname,"..")
}={}) {
  if(typeof token!=="string"||token.length<15||!ACCOUNT_ID.test(accountId||""))
    throw Error("Token de leitura Cloudflare ou Account ID ausente/inválido.");
  const c=JSON.parse(readFileSync(resolve(root,"wrangler.production.template.jsonc"),"utf8"));
  const issues=productionTemplateIssues(c);
  if(issues.length)throw Error("Template de produção inseguro: "+issues.join("; "));
  const prefix="/accounts/"+accountId;
  const paths=[
    prefix+"/d1/database?name="+STAGING.d1,
    prefix+"/d1/database?name="+PRODUCTION.d1,
    prefix+"/r2/buckets?name_contains="+STAGING.r2,
    prefix+"/r2/buckets?name_contains="+PRODUCTION.r2,
    prefix+"/workers/scripts"
  ];
  async function get(path){
    if(!paths.includes(path))throw Error("GET fora da lista de inventário.");
    const response=await fetcher(API+path,{
      method:"GET",redirect:"error",signal:AbortSignal.timeout(20000),
      headers:{Authorization:"Bearer "+token,Accept:"application/json"}
    });
    if(!response.ok)throw Error("Cloudflare negou inventário de recursos (HTTP "+response.status+").");
    const body=await response.json();
    if(body?.success!==true)throw Error("Cloudflare recusou inventário.");
    return body.result;
  }
  const [stageDb,prodDb,stageR2,prodR2,workers]=await Promise.all(paths.map(get));
  const checked=inspectResources(stageDb,prodDb,stageR2,prodR2,workers);
  const domains=[
    "https://tigu-staging.netssh3-0.workers.dev/api/health",
    "https://agendamentos.crjornada.com/api/health"
  ];
  for(const domain of domains){
    const response=await fetcher(domain,{
      method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
      headers:{Accept:"application/json"}
    });
    if(response.status!==200)throw Error("Saúde do staging/dominio não está disponível.");
    const health=await response.json();
    if(health?.ok!==true||health?.staging!==true||
       health?.d1!==true||health?.r2!==true||
       !health?.security?.session_secret_ready||
       !health?.security?.encryption_key_ready)
      throw Error("Staging não está isolado/saudável; domínio não pode ser migrado.");
  }
  return {...checked,domain_still_on_staging:true,
    actions_performed:"GET only",
    resources_created:0,customer_data_copied:false,
    payment_enabled:false,whatsapp_enabled:false,dns_changed:false,
    next:"provisionar recursos separados após aprovar eventuais custos; migrar dados com plano de validação; instalar segredos independentes; testar; somente depois vincular domínio"};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try{
    if(process.argv.length!==2||
       process.env.GITHUB_ACTIONS!=="true"||
       process.env.GITHUB_EVENT_NAME!=="push"||
       process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
       process.env.TIGU_PRODUCTION_READONLY_APPROVED!=="YES")
      throw Error("Inventário exige push único autorizado no CI TIGU.");
    console.log("TIGU Production GET-only inventory:",
      JSON.stringify(await auditProductionResources({
        token:process.env.CLOUDFLARE_STAGING_TOKEN,
        accountId:process.env.CLOUDFLARE_ACCOUNT_ID
      }),null,2));
  }catch(error){
    console.error("TIGU Production GET-only inventory:",
      error instanceof Error?error.message:"Falha de inventário.");
    process.exitCode=1;
  }
}
