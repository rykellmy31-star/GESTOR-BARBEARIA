#!/usr/bin/env node
/**
 * Verificação SOMENTE-LEITURA da prontidão do Pix real do TIGU.
 * Não obtém valores de segredos, não toca dados de clientes, não executa SQL,
 * não publica Worker e nunca habilita pagamentos.
 */
const API="https://api.cloudflare.com/client/v4";
const ACCOUNT=/^[a-f0-9]{32}$/i;
const worker="tigu-production",d1="tigu-production-db",r2="tigu-production-media";
const requiredSecretNames=[
 "MP_MARKETPLACE_CLIENT_ID","MP_MARKETPLACE_CLIENT_SECRET",
 "MP_MARKETPLACE_WEBHOOK_SECRET","MP_MARKETPLACE_REDIRECT_URI",
 "PUBLIC_URL","MSG_ENC_KEY","SESSION_SECRET"
];
export async function inspectPaymentReadiness({
 token,accountId,fetcher=fetch
}={}){
 if(typeof token!=="string"||token.length<15||!ACCOUNT.test(accountId||""))
  throw Error("Credenciais Cloudflare de leitura indisponíveis ou inválidas.");
 const base=API+"/accounts/"+accountId;
 async function read(path){
  if(![
   "/workers/scripts",
   "/d1/database?name="+d1,
   "/r2/buckets?name_contains="+r2,
   "/workers/scripts/"+worker+"/secrets",
   "/workers/scripts/"+worker+"/settings",
  ].includes(path))throw Error("GET fora da lista permitida.");
  const response=await fetcher(base+path,{
   method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
   headers:{Authorization:"Bearer "+token,Accept:"application/json"}
  });
  if(!response.ok)throw Error("Cloudflare negou inventário "+path.split("/").at(-1).split("?")[0]+
   " (HTTP "+response.status+").");
  const body=await response.json();
  if(body?.success!==true)throw Error("Cloudflare rejeitou inventário de produção.");
  return body.result;
 }
 const [workers,databases,storage]=await Promise.all([
  read("/workers/scripts"),read("/d1/database?name="+d1),
  read("/r2/buckets?name_contains="+r2)
 ]);
 if(!Array.isArray(workers)||!Array.isArray(databases)||
    !Array.isArray(storage?.buckets))
   throw Error("Formato de inventário Cloudflare inesperado.");
 const workerExists=workers.some(x=>x?.id===worker);
 const databaseExists=databases.some(x=>x?.name===d1);
 const bucketExists=storage.buckets.some(x=>x?.name===r2);
 let secrets="não avaliados (Worker de produção ausente)";
 let config="não avaliada (Worker de produção ausente)";
 if(workerExists){
  // Cloudflare só devolve nomes e tipos de segredos; nunca imprimir valores.
  const listed=await read("/workers/scripts/"+worker+"/secrets");
  if(!Array.isArray(listed))throw Error("Lista de segredos inválida.");
  const found=new Set(listed.filter(x=>x?.type==="secret_text").map(x=>x.name));
  secrets={
   count_expected:requiredSecretNames.length,
   count_present:requiredSecretNames.filter(x=>found.has(x)).length,
   missing:requiredSecretNames.filter(x=>!found.has(x))
  };
  const settings=await read("/workers/scripts/"+worker+"/settings");
  const bindings=Array.isArray(settings?.bindings)?settings.bindings:[];
  // Não exibir conteúdo de bindings, pois pode incluir dados confidenciais.
  const env=Object.fromEntries(bindings.filter(x=>x?.type==="plain_text"&&
   ["APP_ENV","TIGU_STAGING","PAYMENTS_MOCK","MERCHANT_PIX_ENABLED"].includes(x.name))
   .map(x=>[x.name,x.text]));
  config={
   app_env_production:env.APP_ENV==="production",
   staging_disabled:env.TIGU_STAGING==="0",
   mock_disabled:env.PAYMENTS_MOCK==="0",
   real_pix_enabled:env.MERCHANT_PIX_ENABLED==="1",
   d1_binding_present:bindings.some(x=>x?.name==="DB"&&x?.type==="d1"),
   r2_binding_present:bindings.some(x=>x?.name==="MEDIA"&&x?.type==="r2_bucket")
  };
 }
 return {
  inspection:"Cloudflare GET only",
  production_d1_exists:databaseExists,
  production_r2_exists:bucketExists,
  production_worker_exists:workerExists,
  required_secret_names:secrets,
  production_flags:config,
  activated_by_this_inspection:false,
  changed_resources:0,
  next:!workerExists?"Publicação e configuração inicial do Worker de produção pendentes.":
   "Conferir migrações D1, conteúdo dos segredos sem logar valores, autorização OAuth de um profissional e webhook antes do primeiro Pix real."
 };
}
if(process.argv[1]&&process.argv[1].endsWith("production-payment-readiness-readonly.mjs")){
 try{
  if(process.env.GITHUB_ACTIONS!=="true"||
     process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
     process.env.GITHUB_EVENT_NAME!=="push"||
     process.env.TIGU_PAYMENT_READONLY_APPROVED!=="YES")
   throw Error("Inspeção autorizada apenas pelo gatilho único de verificação.");
  const result=await inspectPaymentReadiness({
   token:process.env.CLOUDFLARE_STAGING_TOKEN,
   accountId:process.env.CLOUDFLARE_ACCOUNT_ID
  });
  console.log("TIGU_REAL_PIX_READINESS:",JSON.stringify(result));
 }catch(e){
  console.error("TIGU_REAL_PIX_READINESS:",e instanceof Error?e.message:"Falha de leitura.");
  process.exitCode=1;
 }
}
