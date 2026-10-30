#!/usr/bin/env node
/**
 * Inventário SOMENTE LEITURA Cloudflare. Não altera Worker, rota, domínio,
 * banco D1, bucket R2 nem segredos. Uso: GitHub Actions no TIGU.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const accountPattern=/^[0-9a-f]{32}$/i;
const ROOT="https://api.cloudflare.com/client/v4";
const OFFICIAL="agendamentos.crjornada.com";
const STAGING="tigu-staging.netssh3-0.workers.dev";
const allowed=new Set(["tigu-staging","tigu-production","tigu-gestor-barbearia","tigu-platform"]);

async function publicHealth(host,fetcher) {
  try {
    const r=await fetcher("https://"+host+"/api/health",{
      method:"GET",redirect:"manual",signal:AbortSignal.timeout(12_000),
      headers:{Accept:"application/json","Cache-Control":"no-store"},
    });
    if(r.status!==200) return {reachable:false,status:r.status};
    const b=await r.json();
    return {
      reachable:b?.service==="tigu-api",
      staging:b?.staging===true,
      d1:b?.d1===true,r2:b?.r2===true,
      paymentsMock:b?.payments?.mock===true,
      whatsappMock:b?.whatsapp?.mock===true,
    };
  }catch{return {reachable:false};}
}

export function classifyDomain(official,staging,domains,workers) {
  const entry=domains?.find(x=>x?.hostname===OFFICIAL);
  const service=typeof entry?.service==="string"?entry.service:null;
  const zone=typeof entry?.zone_name==="string"?entry.zone_name:null;
  const active=entry?.enabled===true;
  const sameHealth=official?.reachable && staging?.reachable &&
    official.staging===staging.staging &&
    official.d1===staging.d1 && official.r2===staging.r2 &&
    official.paymentsMock===staging.paymentsMock && official.whatsappMock===staging.whatsappMock;
  const mappedToStaging=service==="tigu-staging" && active;
  const hasStagingWorker=workers?.includes("tigu-staging")??false;
  const safeToUpdate=official?.staging===false &&
    staging?.staging===true && hasStagingWorker && !mappedToStaging;
  return {
    official_host:OFFICIAL,staging_host:STAGING,
    official_health:official,staging_health:staging,
    public_health_properties_match:!!sameHealth,
    official_custom_domain_mapping:service ? {worker:service,enabled:active,zone:zone==="crjornada.com"?"crjornada.com":"other"} : "unverified",
    staging_worker_exists:hasStagingWorker,
    official_uses_staging_worker:mappedToStaging,
    safe_to_update_staging:safeToUpdate,
    note:official?.staging===true
      ? "DOMINIO OFICIAL RESPONDE COMO STAGING. Não publicar até revisar a rota."
      : (safeToUpdate ? "Separação inicial verificada; exigir homologação D1 isolada antes de qualquer deploy." :
        "Separação não comprovada. NÃO PUBLICAR."),
  };
}

export async function inspectTiguRouting({token,accountId,fetcher=fetch}) {
  const [official,staging]=await Promise.all([
    publicHealth(OFFICIAL,fetcher), publicHealth(STAGING,fetcher),
  ]);
  if(!token || !accountPattern.test(accountId??"")){
    return {
      ...classifyDomain(official,staging,null,null),
      cloudflare_inventory:"unavailable_missing_repo_secret_or_account_id",
      safe_to_update_staging:false,
    };
  }
  async function get(path){
    const res=await fetcher(ROOT+path,{
      method:"GET",redirect:"error",signal:AbortSignal.timeout(15_000),
      headers:{"Authorization":"Bearer "+token,"Accept":"application/json"},
    });
    if(res.status!==200)return {error:"HTTP "+res.status};
    const obj=await res.json().catch(()=>null);
    return obj?.success===true?{result:obj.result}:{error:"invalid_api_response"};
  }
  const base="/accounts/"+accountId;
  const [domains,workers,databases,buckets]=await Promise.all([
    get(base+"/workers/domains"),
    get(base+"/workers/scripts"),
    get(base+"/d1/database?name=tigu-staging-db"),
    get(base+"/r2/buckets?name_contains=tigu-staging-media"),
  ]);
  const scripts=Array.isArray(workers.result)?workers.result.filter(x=>allowed.has(x?.id)).map(x=>x.id):null;
  const report=classifyDomain(official,staging,Array.isArray(domains.result)?domains.result:null,scripts);
  const db=Array.isArray(databases.result)?databases.result.filter(x=>x?.name==="tigu-staging-db"):[];
  const r2=Array.isArray(buckets.result?.buckets)?buckets.result.buckets.filter(x=>x?.name==="tigu-staging-media"):[];
  return {
    ...report,
    stage_inventory:{d1:db.length===1,r2:r2.length===1,workers:scripts??"permission_denied"},
    cloudflare_inventory:{
      domains:domains.error??"readable",workers:workers.error??"readable",
      d1:databases.error??"readable",r2:buckets.error??"readable",
    },
    safe_to_update_staging:report.safe_to_update_staging &&
      db.length===1 && r2.length===1 &&
      Array.isArray(domains.result) && Array.isArray(workers.result),
  };
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==2)throw Error("Sem argumentos permitidos.");
    const report=await inspectTiguRouting({
      token:process.env.CLOUDFLARE_STAGING_TOKEN||process.env.CLOUDFLARE_AUDIT_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    });
    console.log("TIGU — inventário de domínio SOMENTE LEITURA:");
    console.log(JSON.stringify(report,null,2));
    console.log("Nenhum recurso, rota, domínio, segredo, D1 ou R2 foi alterado.");
    if(!report.safe_to_update_staging) {
      console.error("BLOQUEADO: homologação remota/atualização do staging exige segregação comprovada.");
      process.exitCode=1;
    }
  }catch(err){
    console.error("Inventário bloqueado: "+(err instanceof Error?err.message:String(err)));
    process.exitCode=1;
  }
}
