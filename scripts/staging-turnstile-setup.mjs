#!/usr/bin/env node
/**
 * Provisionamento isolado do Turnstile TIGU STAGING.
 * - Bloqueia ambiente/Worker diferentes, credenciais pré-existentes e
 *   widgets com nome conflitante (nunca rotaciona um segredo existente).
 * - Cloudflare API: GET /workers/scripts/tigu-staging/settings,
 *   GET/POST /challenges/widgets.
 * - Apenas 2 secrets novos no Worker tigu-staging via Wrangler STDIN.
 * - Não escreve valores sensíveis em log, arquivo, GitHub ou D1.
 * - Nunca habilita pagamentos, WhatsApp real ou altera produção.
 */
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { inspectExportTarget } from "./staging-d1-export-verify.mjs";

const API="https://api.cloudflare.com/client/v4/accounts/";
const SCRIPT="tigu-staging";
const WIDGET_NAME="TIGU Leads Homologacao 2026";
const HOSTS=["agendamentos.crjornada.com","tigu-staging.netssh3-0.workers.dev"];
const SECRET_KEYS=["SALES_TURNSTILE_SECRET","SALES_TURNSTILE_SITE_KEY"];
const STAGING_URL="https://tigu-staging.netssh3-0.workers.dev";

export async function configureTurnstileStaging({
 token,accountId,fetcher=fetch,
 putSecret=async(key,value,{token,accountId,root})=>{
   const proc=spawnSync("npx",
     ["wrangler","secret","put",key,"--name",SCRIPT],
     {cwd:root,input:value+"\n",encoding:"utf8",timeout:90000,
       maxBuffer:1024*1024,
       env:{...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId,
         WRANGLER_SEND_METRICS:"false"}});
   // Não imprimir stdout ou stderr: scripts de terceiros podem incluir
   // detalhes sensíveis inadvertidamente.
   if(proc.error||proc.status!==0)throw Error("Cloudflare recusou configuração de "+key+"; resultado inconclusivo.");
 },
 root=resolve(import.meta.dirname,".."),
}={}){
 if(typeof token!=="string"||token.length<15||
   !/^[0-9a-f]{32}$/i.test(accountId||""))
   throw Error("Credenciais TIGU staging ausentes ou inválidas.");
 await inspectExportTarget({token,accountId,fetcher});
 const base=API+accountId;
 async function call(method,path,payload){
   const response=await fetcher(base+path,{
     method,redirect:"error",signal:AbortSignal.timeout(25000),
     headers:{Authorization:"Bearer "+token,Accept:"application/json",
       ...(payload?{"Content-Type":"application/json"}:{})},
     ...(payload?{body:JSON.stringify(payload)}:{})
   });
   if(!response.ok)throw Error("Cloudflare não autorizou etapa Turnstile "+method+" (HTTP "+response.status+"). Verifique Account:Turnstile:Edit.");
   const body=await response.json();
   if(body?.success!==true)throw Error("Cloudflare recusou etapa Turnstile "+method+".");
   return body.result;
 }
 const settings=await call("GET","/workers/scripts/"+SCRIPT+"/settings");
 const bindings=settings?.bindings;
 if(!Array.isArray(bindings))throw Error("Configuração de bindings do Worker não verificável.");
 const staging=bindings.find(b=>b.name==="TIGU_STAGING");
 if(staging?.text!=="1"||!bindings.some(b=>b.name==="DB"&&b.type==="d1")||
   !bindings.some(b=>b.name==="MEDIA"&&b.type==="r2_bucket"))
   throw Error("Worker não passou na validação de isolamento staging.");
 const existingSecrets=SECRET_KEYS.filter(key=>bindings.some(b=>b.name===key));
 if(existingSecrets.length)
   throw Error("Turnstile já possui bindings no Worker. Não sobrescrever: confira a configuração manualmente.");
 const widgets=await call("GET","/challenges/widgets?per_page=1000");
 if(!Array.isArray(widgets))throw Error("Inventário de widgets Turnstile inválido.");
 if(widgets.some(w=>w?.name===WIDGET_NAME))
   throw Error("Widget TIGU com este nome já existe; não criar duplicata nem alterar credenciais.");
 // A partir daqui apenas criamos o widget do staging (se o token permitir).
 const created=await call("POST","/challenges/widgets",
   {domains:HOSTS,mode:"managed",name:WIDGET_NAME});
 if(!created||typeof created.secret!=="string"||created.secret.length<15||
    typeof created.sitekey!=="string"||created.sitekey.length<15||
    !HOSTS.every(h=>created.domains?.includes(h)))
   throw Error("Resposta incompleta na criação do widget. Credenciais não foram instaladas.");
 // Instala SECRET primeiro, SITE_KEY depois. Até ambos existirem, a validação
 // server-side continua bloqueando o formulário em APP_ENV=production.
 await putSecret("SALES_TURNSTILE_SECRET",created.secret,{token,accountId,root});
 await putSecret("SALES_TURNSTILE_SITE_KEY",created.sitekey,{token,accountId,root});
 const confirmed=await call("GET","/workers/scripts/"+SCRIPT+"/settings");
 const bs=confirmed?.bindings;
 if(!Array.isArray(bs)||!SECRET_KEYS.every(k=>bs.some(b=>b.name===k)))
   throw Error("Cloudflare não confirmou ambos os segredos Turnstile no Worker.");
 const healthRes=await fetcher(STAGING_URL+"/api/health",{
   method:"GET",redirect:"error",signal:AbortSignal.timeout(12000),
   headers:{Accept:"application/json"}});
 const health=healthRes.ok?await healthRes.json():null;
 if(health?.staging!==true||health?.d1!==true||health?.r2!==true)
   throw Error("Saúde do Worker staging não pôde ser confirmada após instalar secrets.");
 const challengeRes=await fetcher(STAGING_URL+"/api/marketing/lead-config",{
   method:"GET",redirect:"error",signal:AbortSignal.timeout(12000),
   headers:{Accept:"application/json"}});
 const challenge=challengeRes.ok?await challengeRes.json():null;
 if(challenge?.required!==true||challenge?.enabled!==true||
    challenge?.site_key!==created.sitekey)
   throw Error("Turnstile instalado, mas formulário ainda não reporta proteção ativa.");
 return {
   widget_created:true,turnstile_configured:true,
   widget_domains_verified:HOSTS.length,
   worker:SCRIPT,staging_health_verified:true,
   lead_challenge_enabled:true,
   credentials_exposed:false,production_modified:false,
   real_payment_enabled:false,real_whatsapp_enabled:false,
 };
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try {
   if(process.env.GITHUB_ACTIONS!=="true"||
      process.env.GITHUB_EVENT_NAME!=="push"||
      process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
      process.env.GITHUB_REPOSITORY!=="rykellmy31-star/GESTOR-BARBEARIA"||
      process.env.TIGU_TURNSTILE_STAGING_APPROVED!=="YES"||
      process.argv.length!==2)
     throw Error("Turnstile staging exige commit de autorização isolada.");
   const out=await configureTurnstileStaging({
     token:process.env.CLOUDFLARE_STAGING_TOKEN,
     accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
   });
   console.log("TIGU Turnstile staging: "+JSON.stringify(out));
 } catch(err) {
   console.error("TIGU Turnstile staging: "+(err instanceof Error?err.message:"Falha de instalação."));
   process.exitCode=1;
 }
}
