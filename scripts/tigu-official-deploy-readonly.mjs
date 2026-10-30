#!/usr/bin/env node
/**
 * TIGU: inventário somente leitura antes da publicação no domínio oficial.
 * Não imprime secrets nem conteúdo de clientes, não usa POST/PUT/DELETE e
 * não altera workers, domínio, D1, R2 ou rotas.
 */
const accountId=process.env.CLOUDFLARE_ACCOUNT_ID || "";
const token=process.env.CLOUDFLARE_STAGING_TOKEN || "";
const account=/^[0-9a-f]{32}$/i;
const domain="agendamentos.crjornada.com";
const worker="tigu-staging";
const dbName="tigu-staging-db";
const bucket="tigu-staging-media";
const root="https://api.cloudflare.com/client/v4/accounts/"+accountId;
if(!account.test(accountId)||token.length<16){
  console.error("BLOQUEADO: token de leitura/conta Cloudflare ausentes.");
  process.exit(1);
}
async function get(url,cloudflare=false){
  const response=await fetch(url,{method:"GET",redirect:"error",signal:AbortSignal.timeout(20000),
    headers:cloudflare?{Authorization:"Bearer "+token,Accept:"application/json"}:{Accept:"application/json","Cache-Control":"no-store"}});
  if(!response.ok)throw Error("GET indisponível (HTTP "+response.status+").");
  const obj=await response.json();
  if(cloudflare && obj?.success!==true)throw Error("API Cloudflare não autorizou o inventário.");
  return cloudflare?obj.result:obj;
}
try{
  const [h,domains,workers,dbs,r2,settings]=await Promise.all([
    get("https://"+domain+"/api/health"),
    get(root+"/workers/domains",true),
    get(root+"/workers/scripts",true),
    get(root+"/d1/database?name="+dbName,true),
    get(root+"/r2/buckets?name_contains="+bucket,true),
    get(root+"/workers/scripts/"+worker+"/settings",true),
  ]);
  const mapped=Array.isArray(domains)?domains.filter(x=>x.hostname===domain):[];
  const names=Array.isArray(workers)?workers.map(x=>x.id):[];
  const db=Array.isArray(dbs)?dbs.filter(x=>x.name===dbName):[];
  const buckets=Array.isArray(r2?.buckets)?r2.buckets.filter(x=>x.name===bucket):[];
  const bindings=Array.isArray(settings?.bindings)?settings.bindings:[];
  const d1Bindings=bindings.filter(x=>x.type==="d1"||x.type==="d1_database");
  const r2Bindings=bindings.filter(x=>x.type==="r2_bucket");
  const vars=bindings.filter(x=>x.type==="plain_text").map(x=>({name:x.name,
    value:x.name==="TIGU_STAGING"||x.name==="APP_ENV"||x.name==="WHATSAPP_MOCK"?String(x.text):"redacted"}));
  const report={
    domain,worker,publicHealthy:h?.ok===true&&h?.service==="tigu-api",
    domainMappingVerified:mapped.length===1&&mapped[0].service===worker&&mapped[0].enabled===true,
    officialStagingFlag:h?.staging===true,
    workerExists:names.includes(worker),d1Found:db.length===1,r2Found:buckets.length===1,
    d1BindingMatches:d1Bindings.some(x=>x.name==="DB"&&x.id===db[0]?.uuid),
    r2BindingMatches:r2Bindings.some(x=>x.name==="MEDIA"&&x.bucket_name===bucket),
    d1BindingCount:d1Bindings.length,r2BindingCount:r2Bindings.length,
    nonsecretEnvFlags:vars,
    otherBindingNames:bindings.filter(x=>!["plain_text","secret_text","d1","d1_database","r2_bucket"].includes(x.type)).map(x=>({name:x.name,type:x.type})),
    secretBindingNames:bindings.filter(x=>x.type==="secret_text").map(x=>x.name).sort(),
    criticalNote:"A conexão Evolution real não funciona com TIGU_STAGING=1; instalar Evolution API ainda está pendente.",
  };
  console.log("TIGU — auditoria de deploy (SOMENTE LEITURA)\n"+JSON.stringify(report,null,2));
  if(!report.publicHealthy||!report.domainMappingVerified||!report.workerExists||!report.d1Found||!report.r2Found||
    !report.d1BindingMatches||!report.r2BindingMatches||!report.officialStagingFlag){
      throw Error("Recursos e bindings não foram validados. Publicação bloqueada.");
    }
  console.log("PASS: dados de roteamento/bindings verificados. NENHUMA PUBLICAÇÃO REALIZADA.");
}catch(e){console.error("BLOQUEADO: "+String(e?.message||e));process.exitCode=1;}
