#!/usr/bin/env node
/**
 * Diagnóstico e atualização do Worker que ATENDE o domínio oficial existente.
 * Jamais troca DNS/rotas, D1, R2, secrets, sessões ou outros projetos.
 * Backup validado ANTES de qualquer migração; migração aditiva 0103 exclusivamente.
 */
import {readFileSync,writeFileSync,existsSync,unlinkSync,readdirSync} from "node:fs";
import {resolve,join} from "node:path";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {exportAndCheckStaging} from "./staging-d1-export-verify.mjs";

const API="https://api.cloudflare.com/client/v4";
const ACCOUNT=/^[0-9a-f]{32}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const TARGET=Object.freeze({
  hostname:"agendamentos.crjornada.com",worker:"tigu-staging",
  database:"tigu-staging-db",bucket:"tigu-staging-media",
  url:"https://agendamentos.crjornada.com",
});
function exactly(items,key,value){
  if(!Array.isArray(items))throw Error("Inventário Cloudflare inválido.");
  const matches=items.filter(x=>x?.[key]===value);
  if(matches.length!==1)throw Error("Recurso "+value+" ausente ou duplicado; cancelar.");
  return matches[0];
}
async function readHealth(fetcher){
  const r=await fetcher(TARGET.url+"/api/health",{method:"GET",redirect:"error",
    signal:AbortSignal.timeout(15000),headers:{"Cache-Control":"no-store"}});
  const h=await r.json().catch(()=>null);
  if(r.status!==200||h?.ok!==true||h?.service!=="tigu-api"||
    h.staging!==true||h.d1!==true||h.r2!==true||
    h.security?.session_secret_ready!==true||h.security?.encryption_key_ready!==true)
    throw Error("Domínio oficial não corresponde ao Worker saudável anteriormente auditado.");
  return {staging:h.staging,d1:h.d1,r2:h.r2,
    sessionSecretReady:h.security.session_secret_ready,
    encryptionKeyReady:h.security.encryption_key_ready,
    mpConfigured:h.payments?.mercadopago===true,
    mpMock:h.payments?.mock===true,
    waMock:h.whatsapp?.mock===true,waEmbedded:h.whatsapp?.embedded===true};
}
export function inspectOfficialInventory(dbs,media,workers,domains,settings,history,expectedNames){
  const db=exactly(dbs,"name",TARGET.database);
  if(!UUID.test(db.uuid||""))throw Error("UUID D1 oficial inválido.");
  exactly(media?.buckets,"name",TARGET.bucket);
  exactly(workers,"id",TARGET.worker);
  const domain=exactly(domains,"hostname",TARGET.hostname);
  if(domain.service!==TARGET.worker||domain.enabled!==true)
    throw Error("O domínio oficial aponta para outro Worker. NÃO publicar.");
  const raw=Array.isArray(settings?.bindings)?settings.bindings:[];
  if(raw.length===0)throw Error("Cloudflare não retornou bindings existentes do Worker; recusar publicação.");
  const dbBinding=exactly(raw,"name","DB");
  const mediaBinding=exactly(raw,"name","MEDIA");
  if(!["d1","d1_database"].includes(dbBinding.type)||dbBinding.id!==db.uuid)
    throw Error("Binding D1 atual não corresponde ao banco oficial.");
  if(mediaBinding.type!=="r2_bucket"||mediaBinding.bucket_name!==TARGET.bucket)
    throw Error("Binding R2 atual não corresponde ao bucket oficial.");
  const secretNames=raw.filter(x=>x?.type==="secret_text").map(x=>x.name);
  for(const key of ["SESSION_SECRET","MSG_ENC_KEY"])
    if(!secretNames.includes(key))throw Error("Secret essencial ausente no Worker oficial: "+key);
  const allowedTypes=new Set(["d1","d1_database","r2_bucket","assets","secret_text","plain_text","json"]);
  if(raw.some(x=>!allowedTypes.has(x?.type)))
    throw Error("Binding remoto não previsto: não arriscar alterações no Worker.");
  const vars=Object.fromEntries(raw.filter(x=>x?.type==="plain_text").map(x=>[x.name,x.text]));
  if(vars.APP_ENV!=="production"||vars.TIGU_STAGING!=="1"||
    vars.WHATSAPP_MOCK!=="1"||vars.PAYMENTS_MOCK!=="0")
    throw Error("Flags Cloudflare mudaram; modo operacional precisa ser revisado.");
  if(!Array.isArray(history)||!Array.isArray(expectedNames)||expectedNames.length!==26)
    throw Error("Histórico de migrações remoto ou arquivos de código inválidos.");
  const pending=expectedNames.filter(x=>!history.includes(x));
  const unknown=history.filter(x=>!expectedNames.includes(x));
  if(unknown.length||pending.length!==1||pending[0]!=="0103_manual_platform_subscriptions.sql"||history.length!==25)
    throw Error("Histórico D1 diverge: "+JSON.stringify({applied_count:history.length,applied_names:history,pending_names:pending,unknown_names:unknown})+". Nenhuma migração executada.");
  return {dbId:db.uuid,existingVars:vars,existingSecretNames:secretNames,
    existingBindingTypes:raw.map(x=>x.type),pendingMigration:pending[0],
    appliedMigrationCount:history.length,
    domainBound:true,officialWorker:TARGET.worker};
}
export async function inspectRemote({token,accountId,fetcher=fetch,root=resolve(import.meta.dirname,"..")}){
  if(typeof token!=="string"||token.length<15||!ACCOUNT.test(accountId||""))
    throw Error("Token de publicação TIGU ou Account ID ausente ou inválido.");
  const account="/accounts/"+accountId;
  const auth={Authorization:"Bearer "+token,Accept:"application/json"};
  async function request(method,path,body){
    const r=await fetcher(API+path,{method,redirect:"error",signal:AbortSignal.timeout(25000),
      headers:{...auth,...(body?{"Content-Type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{})});
    if(!r.ok)throw Error("Cloudflare não autorizou consulta de inventário (HTTP "+r.status+").");
    const json=await r.json().catch(()=>null);
    if(json?.success!==true)throw Error("Cloudflare recusou leitura do inventário.");
    return json.result;
  }
  const [dbs,media,workers,domains,settings]=await Promise.all([
    request("GET",account+"/d1/database?name="+TARGET.database),
    request("GET",account+"/r2/buckets?name_contains="+TARGET.bucket),
    request("GET",account+"/workers/scripts"),
    request("GET",account+"/workers/domains"),
    request("GET",account+"/workers/scripts/"+TARGET.worker+"/settings"),
  ]);
  const db=exactly(dbs,"name",TARGET.database);
  if(!UUID.test(db.uuid||""))throw Error("D1 UUID inesperado.");
  // Consulta SQL APENAS SELECT, sem ler registros de barbearias/clientes.
  const migrations=await request("POST",account+"/d1/database/"+db.uuid+"/query",{
    sql:"SELECT name FROM d1_migrations ORDER BY id",params:[]
  });
  if(!Array.isArray(migrations)||!migrations[0]?.success||
    !Array.isArray(migrations[0].results))throw Error("Histórico D1 não consultável.");
  const names=migrations[0].results.map(r=>r.name);
  const expectedNames=readdirSync(join(root,"migrations"))
    .filter(n=>/^\d+.*\.sql$/.test(n)).sort();
  const inv=inspectOfficialInventory(dbs,media,workers,domains,settings,names,expectedNames);
  const health=await readHealth(fetcher);
  if(health.mpMock===true||health.waMock!==true)
    throw Error("Flags reais do Worker mudaram desde a auditoria; abortar.");
  return {inventory:inv,health,
    summary:{officialDomain:TARGET.hostname,worker:TARGET.worker,
      database:TARGET.database,bucket:TARGET.bucket,pendingMigration:inv.pendingMigration,
      secretsPreserved:true,appliedMigrationCount:inv.appliedMigrationCount}};
}

export async function releaseOfficial({token,accountId,root=resolve(import.meta.dirname,".."),
  fetcher=fetch,execute=execFileSync}={}){
  const before=await inspectRemote({token,accountId,root,fetcher});
  console.log("Pré-verificação oficial aprovada: "+JSON.stringify(before.summary));
  const backup=await exportAndCheckStaging({token,accountId,root,fetcher,exec:execute});
  if(backup?.sql_exported!==true||backup.local_sqlite_restore_verified!==true||
     backup.integrity!=="ok"||backup.foreign_keys!=="ok")
    throw Error("Backup D1 não passou na restauração SQLite. NÃO PUBLICAR.");
  console.log("Exportação D1 e restauração local verificadas. Dump descartado. SHA-256: "+backup.sha256);
  const cfg=JSON.parse(readFileSync(join(root,"wrangler.staging.template.jsonc"),"utf8"));
  cfg.d1_databases[0].database_id=before.inventory.dbId;
  // Somente código, sem trocar flags de pagamentos ou credenciais dos profissionais.
  cfg.vars={...cfg.vars,TIGU_PLATFORM_BILLING_MODE:"manual"};
  cfg.keep_vars=true;
  // Domínio continua gerenciado pela Cloudflare. Não reconfigurar rotas/DNS.
  if(cfg.name!==TARGET.worker||cfg.d1_databases[0].database_name!==TARGET.database||
    cfg.r2_buckets[0].bucket_name!==TARGET.bucket||
    cfg.vars.APP_ENV!=="production"||cfg.vars.TIGU_STAGING!=="1"||
    cfg.vars.WHATSAPP_MOCK!=="1"||cfg.vars.PAYMENTS_MOCK!=="0"||
    cfg.triggers.crons.length!==0||cfg.routes||cfg.route)
    throw Error("Config gerada difere do Worker oficial e dos recursos antigos.");
  // Garantir que todas as vars do Dashboard persistem; não enviar segredos para arquivo.
  for(const [k,v] of Object.entries(before.inventory.existingVars))
    if(Object.hasOwn(cfg.vars,k)&&cfg.vars[k]!==v&&k!=="TIGU_PLATFORM_BILLING_MODE")
      throw Error("Variável existente "+k+" diverge do template; recusar atualização.");
  // Wrangler resolves main/assets/migrations relative to the config. Keep it at repository root.
  const path=join(root,"wrangler.official.release.auto.jsonc");
  if(existsSync(path))throw Error("Configuração oficial temporária já existe; não sobrescrever.");
  const env={...process.env,CLOUDFLARE_API_TOKEN:token,
    CLOUDFLARE_ACCOUNT_ID:accountId,CLOUDFLARE_SEND_METRICS:"false",
    WRANGLER_SEND_METRICS:"false"};
  const cli=join(root,"node_modules","wrangler","bin","wrangler.js");
  function run(...args){
    return execute(process.execPath,[cli,...args,"--config",path],{
      cwd:root,env,stdio:"inherit",timeout:180000,
    });
  }
  try {
    writeFileSync(path,JSON.stringify(cfg,null,2)+"\n",{mode:0o600,flag:"wx"});
    // Este comando salva backup automático Cloudflare antes de executar a migration.
    run("d1","migrations","apply",TARGET.database,"--remote");
    // Atualiza SOMENTE Worker existente. --keep-vars preserva variáveis e secrets remotos.
    run("deploy","--keep-vars");
    const now=await readHealth(fetcher);
    for(const key of ["staging","d1","r2","sessionSecretReady","encryptionKeyReady",
      "mpConfigured","mpMock","waMock","waEmbedded"])
      if(now[key]!==before.health[key])
        throw Error("ALERTA após publicação: propriedade oficial "+key+" foi alterada.");
    const check=await fetcher(TARGET.url+"/api/marketing/plans",{
      method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
      headers:{"Cache-Control":"no-store"}
    });
    const plans=await check.json().catch(()=>null);
    if(check.status!==200||plans?.automatic_billing!==false||
      !Array.isArray(plans.plans)||plans.plans.length<3)
      throw Error("Publicação chegou ao domínio, mas planos não foram validados.");
    const postInv=await inspectOfficialBindingAfter({token,accountId,fetcher,
      initial:before.inventory});
    return {released:true,officialUrl:TARGET.url,worker:TARGET.worker,
      backup_export_validated:true,d1_migration:"0103_manual_platform_subscriptions.sql",
      existing_users_and_subscriptions_preserved:true,
      vars_and_secrets_preserved:true,manual_billing:true,
      domain_route_preserved:postInv,health:now,
      note:"O Worker oficial já usava TIGU_STAGING=1; a atualização preservou esse estado."};
  } finally {
    if(existsSync(path))unlinkSync(path);
  }
}
async function inspectOfficialBindingAfter({token,accountId,fetcher,initial}){
  const base=API+"/accounts/"+accountId;
  async function read(path){
    const r=await fetcher(base+path,{method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
      headers:{Authorization:"Bearer "+token,Accept:"application/json"}});
    const j=await r.json().catch(()=>null);
    if(!r.ok||j?.success!==true)throw Error("Falha de verificação de vínculo após deploy.");
    return j.result;
  }
  const [domains,settings]=await Promise.all([
    read("/workers/domains"),read("/workers/scripts/"+TARGET.worker+"/settings")]);
  const match=exactly(domains,"hostname",TARGET.hostname);
  if(match.service!==TARGET.worker||match.enabled!==true)
    throw Error("ALERTA: Worker do domínio oficial mudou após o deploy.");
  const bindings=settings?.bindings;
  if(!Array.isArray(bindings))throw Error("Bindings não retornaram após publicação.");
  if(exactly(bindings,"name","DB").id!==initial.dbId||
    exactly(bindings,"name","MEDIA").bucket_name!==TARGET.bucket)
    throw Error("ALERTA: DB/R2 alterados após publicação.");
  for(const name of initial.existingSecretNames)
    if(!bindings.some(x=>x?.type==="secret_text"&&x.name===name))
      throw Error("ALERTA: segredo anterior "+name+" não foi preservado.");
  return true;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==2||process.env.GITHUB_ACTIONS!=="true"||
      process.env.GITHUB_REPOSITORY!=="rykellmy31-star/GESTOR-BARBEARIA"||
      process.env.GITHUB_REF!=="refs/heads/feature/tigu-mensalidade-manual-preintegracao-20261028"||
      process.env.TIGU_OFFICIAL_DEPLOY_APPROVED!=="YES"||
      process.env.GITHUB_EVENT_NAME!=="push")
      throw Error("Publicação oficial exige gatilho GitHub Actions autorizado.");
    const result=await releaseOfficial({token:process.env.CLOUDFLARE_STAGING_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID});
    console.log("TIGU OFICIAL ATUALIZADO: "+JSON.stringify(result,null,2));
  }catch(error){
    console.error("TIGU OFICIAL NÃO APROVADO: "+(error instanceof Error?error.message:String(error)));
    process.exitCode=1;
  }
}
