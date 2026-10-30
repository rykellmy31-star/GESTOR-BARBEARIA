#!/usr/bin/env node
/** Deploy restrito: remove código Meta, publica exclusivamente Evolution no TIGU oficial.
 * Sem novos recursos, DNS, mudança de rota, schema, credenciais nem pagamentos.
 * O modo TIGU_STAGING=1 é preservado. Backup D1 conferido antes do deploy.
 */
import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { exportAndCheckStaging } from "./staging-d1-export-verify.mjs";

const API="https://api.cloudflare.com/client/v4";
const ROOT=resolve(import.meta.dirname,"..");
const TARGET=Object.freeze({
  host:"agendamentos.crjornada.com",
  worker:"tigu-staging",db:"tigu-staging-db",r2:"tigu-staging-media",
});
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const account=/^[0-9a-f]{32}$/i;
function one(items,key,value){
  if(!Array.isArray(items))throw Error("Inventário incompleto.");
  const hits=items.filter(x=>x?.[key]===value);
  if(hits.length!==1)throw Error("Recurso esperado não encontrado ou duplicado: "+value);
  return hits[0];
}
function ensure(cond,msg){if(!cond)throw Error(msg);}
async function health(fetcher){
 const res=await fetcher("https://"+TARGET.host+"/api/health",{
  method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
  headers:{"Cache-Control":"no-store",Accept:"application/json"}});
 const h=await res.json().catch(()=>null);
 ensure(res.status===200&&h?.ok===true&&h.service==="tigu-api"&&h.d1===true&&h.r2===true&&
  h.staging===true&&h.security?.session_secret_ready===true&&h.security?.encryption_key_ready===true,
  "Worker oficial indisponível ou configurações de segurança divergentes.");
 return {staging:h.staging,d1:h.d1,r2:h.r2,
  mpMock:h.payments?.mock,mercadoPago:h.payments?.mercadopago,
  waMock:h.whatsapp?.mock,session:h.security.session_secret_ready,
  encryption:h.security.encryption_key_ready};
}
export function checkInventory({dbs,buckets,workers,domains,settings,migrations,expected}){
 const db=one(dbs,"name",TARGET.db);
 ensure(uuid.test(db.uuid||""),"UUID D1 inválido.");
 one(buckets?.buckets,"name",TARGET.r2);
 one(workers,"id",TARGET.worker);
 const route=one(domains,"hostname",TARGET.host);
 ensure(route.service===TARGET.worker&&route.enabled===true,"Domínio oficial apontando para Worker inesperado.");
 const bindings=settings?.bindings;
 ensure(Array.isArray(bindings)&&bindings.length>0,"Bindings inexistentes.");
 ensure(["d1","d1_database"].includes(one(bindings,"name","DB").type)&&
  one(bindings,"name","DB").id===db.uuid,"D1 oficial diferente.");
 ensure(one(bindings,"name","MEDIA").type==="r2_bucket"&&
  one(bindings,"name","MEDIA").bucket_name===TARGET.r2,"R2 oficial diferente.");
 const secrets=bindings.filter(x=>x.type==="secret_text").map(x=>x.name);
 for(const name of ["SESSION_SECRET","MSG_ENC_KEY"])
  ensure(secrets.includes(name),"Secret necessário ausente: "+name);
 const vars=Object.fromEntries(bindings.filter(x=>x.type==="plain_text").map(x=>[x.name,x.text]));
 ensure(vars.APP_ENV==="production"&&vars.TIGU_STAGING==="1"&&vars.WHATSAPP_MOCK==="1"&&
  vars.PAYMENTS_MOCK==="0","Variáveis de operação mudaram; não publicar.");
 ensure(Array.isArray(migrations)&&Array.isArray(expected)&&
  migrations.length===expected.length&&expected.length===27&&
  expected.every((name,index)=>migrations[index]===name),
  "Migrações D1 inesperadas ou pendentes: não publicar sem inventário de dados.");
 return {dbId:db.uuid,vars,secrets,originalBindings:bindings,worker:TARGET.worker};
}
export async function deployEvolutionOnly({token,accountId,fetcher=fetch,exec=execFileSync,root=ROOT}={}){
 ensure(typeof token==="string"&&token.length>=16&&account.test(accountId||""),
  "Token ou account ID ausente.");
 const prefix="/accounts/"+accountId,auth={Authorization:"Bearer "+token,Accept:"application/json"};
 async function request(path,method="GET",body){
  const r=await fetcher(API+path,{
    method,redirect:"error",signal:AbortSignal.timeout(25000),
    headers:{...auth,...(body?{"Content-Type":"application/json"}:{})},
    ...(body?{body:JSON.stringify(body)}:{})});
  const result=await r.json().catch(()=>null);
  ensure(r.ok&&result?.success===true,"Cloudflare recusou leitura de inventário ("+r.status+").");
  return result.result;
 }
 const [dbs,buckets,workers,domains,settings]=await Promise.all([
   request(prefix+"/d1/database?name="+TARGET.db),
   request(prefix+"/r2/buckets?name_contains="+TARGET.r2),
   request(prefix+"/workers/scripts"),
   request(prefix+"/workers/domains"),
   request(prefix+"/workers/scripts/"+TARGET.worker+"/settings"),
 ]);
 const db=one(dbs,"name",TARGET.db);
 const result=await request(prefix+"/d1/database/"+db.uuid+"/query","POST",{
   sql:"SELECT name FROM d1_migrations ORDER BY id",params:[],
 });
 ensure(Array.isArray(result)&&result[0]?.success===true&&Array.isArray(result[0].results),
  "D1 não retornou histórico válido.");
 const history=result[0].results.map(x=>x.name);
 const expected=readdirSync(join(root,"migrations")).filter(n=>/^\d+.*\.sql$/.test(n)).sort();
 const inv=checkInventory({dbs,buckets,workers,domains,settings,migrations:history,expected});
 const before=await health(fetcher);
 ensure(before.mpMock===false&&before.waMock===true,"Ambiente divergente antes do deploy.");
 const backup=await exportAndCheckStaging({token,accountId,fetcher,exec,root});
 ensure(backup.sql_exported===true&&backup.local_sqlite_restore_verified===true&&
  backup.integrity==="ok"&&backup.foreign_keys==="ok",
  "Backup D1 não passou na restauração local. Publicação abortada.");
 console.log("Backup D1 restaurado e validado; dump descartado. SHA256: "+backup.sha256);
 const template=JSON.parse(readFileSync(join(root,"wrangler.staging.template.jsonc"),"utf8"));
 template.d1_databases[0].database_id=inv.dbId;
 template.vars={...template.vars,TIGU_PLATFORM_BILLING_MODE:"manual",
    TIGU_EVOLUTION_LIVE:"1", EVOLUTION_API_URL:"https://evolution.crjornada.com",
    PUBLIC_URL:"https://agendamentos.crjornada.com"};
 template.triggers.crons=["* * * * *"];
 template.keep_vars=true;
 ensure(template.name===TARGET.worker&&template.d1_databases[0].database_name===TARGET.db&&
  template.r2_buckets[0].bucket_name===TARGET.r2&&template.vars.APP_ENV==="production"&&
  template.vars.TIGU_STAGING==="1"&&template.vars.WHATSAPP_MOCK==="1"&&
  template.vars.PAYMENTS_MOCK==="0"&&template.vars.TIGU_EVOLUTION_LIVE==="1"&&
  template.vars.EVOLUTION_API_URL==="https://evolution.crjornada.com"&&
  template.vars.PUBLIC_URL==="https://agendamentos.crjornada.com"&&
  template.triggers.crons.length===1&&template.triggers.crons[0]==="* * * * *"&&
  !template.routes&&!template.route,
  "Configuração Wrangler não corresponde ao Worker oficial.");
 for(const [name,value] of Object.entries(inv.vars))
  if(Object.hasOwn(template.vars,name)&&name!=="TIGU_PLATFORM_BILLING_MODE")
   ensure(template.vars[name]===value,"Variável diferente no servidor: "+name);
 const path=join(root,"wrangler.evolution-only.generated.jsonc");
 ensure(!existsSync(path),"Arquivo temporário já existe; abortar.");
 const cli=join(root,"node_modules","wrangler","bin","wrangler.js");
 const env={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId,
  CLOUDFLARE_SEND_METRICS:"false",WRANGLER_SEND_METRICS:"false"};
 try{
  writeFileSync(path,JSON.stringify(template,null,2)+"\n",{mode:0o600,flag:"wx"});
  // Somente deploy do código; NUNCA executar d1 migration apply nem deletar recursos.
  exec(process.execPath,[cli,"deploy","--keep-vars","--config",path],{
    cwd:root,env,stdio:"inherit",timeout:180000});
  const after=await health(fetcher);
  for(const name of Object.keys(before))ensure(after[name]===before[name],
    "ALERTA: saúde ou configuração alterada após publicação: "+name);
  const finalSettings=await request(prefix+"/workers/scripts/"+TARGET.worker+"/settings");
  const finalDomains=await request(prefix+"/workers/domains");
  ensure(one(finalDomains,"hostname",TARGET.host).service===TARGET.worker,
    "ALERTA: vínculo do domínio mudou.");
  ensure(one(finalSettings?.bindings,"name","DB").id===inv.dbId&&
    one(finalSettings.bindings,"name","MEDIA").bucket_name===TARGET.r2,
    "ALERTA: binding banco/arquivos alterado.");
  for(const secret of inv.secrets)ensure(finalSettings.bindings.some(x=>x.type==="secret_text"&&x.name===secret),
    "ALERTA: segredo antigo não preservado: "+secret);
  const publicRes=await fetcher("https://"+TARGET.host+"/api/health",{
    method:"GET",redirect:"error",signal:AbortSignal.timeout(15000)});
  const healthJson=await publicRes.json();
  ensure(healthJson?.whatsapp?.provider==="evolution",
    "Código publicado mas a versão pública ainda não confirmou Evolution como provedor.");
  const old=await fetcher("https://"+TARGET.host+"/api/webhooks/whatsapp",{method:"GET",
    redirect:"error",signal:AbortSignal.timeout(15000)});
  ensure(old.status===404,"Webhook legado Meta permanece acessível.");
  return {deployed:true,domain:TARGET.host,worker:TARGET.worker,
  evolution_qr_code_published:true, evolution_enabled_when_credentials_are_set:true,
    backup_verified:true,migrations_applied:0,data_preserved:true,
    secrets_preserved:true,payments_preserved:true,provider:"evolution",
    meta_webhook_removed:true,staging_preserved:true};
 }finally{rmSync(path,{force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try {
  ensure(process.argv.length===2&&process.env.GITHUB_ACTIONS==="true"&&
   process.env.GITHUB_EVENT_NAME==="push"&&
   process.env.GITHUB_REPOSITORY==="rykellmy31-star/GESTOR-BARBEARIA"&&
   process.env.GITHUB_REF==="refs/heads/feature/tigu-evolution-only-20261029"&&
   process.env.TIGU_EVOLUTION_ONLY_DEPLOY_APPROVED==="YES","Gatilho de publicação não autorizado.");
  const result=await deployEvolutionOnly({
    token:process.env.CLOUDFLARE_STAGING_TOKEN,
    accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
  });
  console.log("TIGU EVOLUTION-ONLY PUBLICADO:",JSON.stringify(result));
 }catch(error){console.error("PUBLICACAO ABORTADA:",String(error?.message||error));process.exitCode=1;}
}
