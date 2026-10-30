#!/usr/bin/env node
/**
 * TIGU - publicação ÚNICA e ISOLADA autorizada em 2026-10-29.
 *
 * Não modifica tigu-staging (o domínio oficial atualmente aponta para ele),
 * tigu-production, domínio, rotas, bancos/buckets existentes ou outros projetos.
 * Usa nomes EXCLUSIVOS, recusa recursos preexistentes, sem pagamentos/Meta reais.
 */
import {readFileSync,writeFileSync,existsSync} from "node:fs";
import {resolve} from "node:path";
import {randomBytes} from "node:crypto";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";

export const NAMES=Object.freeze({
  worker:"tigu-homolog-manual-20261029",
  database:"tigu-homolog-manual-20261029-db",
  bucket:"tigu-homolog-manual-20261029-media",
  domain:"agendamentos.crjornada.com",
  publicHost:"tigu-homolog-manual-20261029.netssh3-0.workers.dev",
});
const API="https://api.cloudflare.com/client/v4";
const ID=/^[a-f0-9]{32}$/i;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fixedWorkerNames=new Set(["tigu-staging","tigu-production","tigu-platform","tigu-gestor-barbearia"]);

function matches(items,key,value){
  if(!Array.isArray(items)) throw Error("Inventário da Cloudflare inválido.");
  return items.filter(x=>x?.[key]===value);
}
export function preflightInventory({dbs,buckets,workers,domains}){
  const records=domains;
  const d=matches(dbs,"name",NAMES.database);
  const b=matches(buckets?.buckets,"name",NAMES.bucket);
  const w=matches(workers,"id",NAMES.worker);
  if(!Array.isArray(records)) throw Error("Inventário de domínios indisponível.");
  if(d.length||b.length||w.length)
    throw Error("Recurso de homologação já existe. Recusado sobrescrever ou aplicar SQL em recursos preexistentes.");
  if(workers.some(x=>fixedWorkerNames.has(x?.id) && x?.id===NAMES.worker))
    throw Error("Nome do Worker protegido.");
  if(records.some(x=>x?.service===NAMES.worker))
    throw Error("Worker de homologação já vinculado a domínio; publicação recusada.");
  const official=records.find(x=>x?.hostname===NAMES.domain);
  if(!official)throw Error("Domínio oficial não encontrado no inventário; não publicar sem conhecer a rota.");
  if(official?.service!== "tigu-staging" || official.enabled!==true)
    throw Error("Vínculo oficial diferente do auditado. Publicação bloqueada para revisão.");
  return {no_existing_resources:true,official_worker:official.service,official_unchanged:true};
}
export function makeConfig(databaseId,template){
  if(!UUID.test(databaseId||""))throw Error("UUID D1 criado inválido.");
  const config=structuredClone(template);
  config.name=NAMES.worker;
  config.workers_dev=true;
  config.vars={...config.vars,TIGU_PLATFORM_BILLING_MODE:"manual"};
  config.d1_databases=[{binding:"DB",database_name:NAMES.database,database_id:databaseId,migrations_dir:"migrations"}];
  config.r2_buckets=[{binding:"MEDIA",bucket_name:NAMES.bucket}];
  if(config.name!==NAMES.worker||config.vars.APP_ENV!=="production"||
    config.vars.TIGU_STAGING!=="1"||config.vars.WHATSAPP_MOCK!=="1"||
    config.vars.PAYMENTS_MOCK!=="0"||config.vars.TIGU_PLATFORM_BILLING_MODE!=="manual"||
    config.triggers?.crons?.length!==0 || config.routes || config.route || config.zone_id ||
    config.d1_databases[0].database_name==="tigu-staging-db"||
    config.r2_buckets[0].bucket_name==="tigu-staging-media")
      throw Error("Configuração insegura: staging, pagamentos ou roteamento inesperados.");
  return config;
}
export async function deployIsolated({token,accountId,fetcher=fetch,run=execFileSync,root=process.cwd()}){
  if(typeof token!=="string"||token.length<15||!ID.test(accountId||""))
    throw Error("Token Cloudflare staging ou Account ID ausente/inválido.");
  const rootApi="/accounts/"+accountId;
  const headers={Authorization:"Bearer "+token,Accept:"application/json"};
  async function api(method,path,body){
    const allowedGET=new Set([
      "/user/tokens/verify",rootApi+"/d1/database?name="+NAMES.database,
      rootApi+"/r2/buckets?name_contains="+NAMES.bucket,
      rootApi+"/workers/scripts",rootApi+"/workers/domains",
    ]);
    const allowedPOST=new Set([rootApi+"/d1/database",rootApi+"/r2/buckets"]);
    if((method==="GET"&&!allowedGET.has(path))||
       (method==="POST"&&(!allowedPOST.has(path)||!body||
        Object.keys(body).length!==1||
        !((path.endsWith("/d1/database")&&body.name===NAMES.database)||
          (path.endsWith("/r2/buckets")&&body.name===NAMES.bucket))))||
       !["GET","POST"].includes(method))
       throw Error("Método, recurso ou payload Cloudflare não autorizado.");
    const r=await fetcher(API+path,{
      method,redirect:"error",signal:AbortSignal.timeout(30000),
      headers:{...headers,...(body?{"Content-Type":"application/json"}:{})},
      ...(body?{body:JSON.stringify(body)}:{}),
    });
    if(!r.ok)throw Error("Cloudflare recusou "+method+" em inventário/homologação (HTTP "+r.status+").");
    const parsed=await r.json().catch(()=>null);
    if(parsed?.success!==true)throw Error("Cloudflare respondeu erro de autorização/inventário.");
    return parsed.result;
  }
  const tokenStatus=await api("GET","/user/tokens/verify");
  if(tokenStatus?.status!=="active")throw Error("Token Cloudflare não ativo.");
  const [dbs,buckets,workers,domains]=await Promise.all([
    api("GET",rootApi+"/d1/database?name="+NAMES.database),
    api("GET",rootApi+"/r2/buckets?name_contains="+NAMES.bucket),
    api("GET",rootApi+"/workers/scripts"),
    api("GET",rootApi+"/workers/domains"),
  ]);
  const verified=preflightInventory({dbs,buckets,workers,domains});
  const template=JSON.parse(readFileSync(resolve(root,"wrangler.staging.template.jsonc"),"utf8"));
  const file=resolve(root,"wrangler.homolog-manual-20261029.generated.jsonc");
  if(existsSync(file))throw Error("Config temporária já existe; recusado sobrescrever.");
  // Todos os recursos têm nomes novos e não estão mapeados para domínio oficial.
  const db=await api("POST",rootApi+"/d1/database",{name:NAMES.database});
  if(db?.name!==NAMES.database||!UUID.test(db?.uuid||""))
    throw Error("D1 criado, mas identificação inesperada. Parar e revisar.");
  const media=await api("POST",rootApi+"/r2/buckets",{name:NAMES.bucket});
  if(media?.name!==NAMES.bucket)
    throw Error("R2 criado, mas identificação inesperada. Parar e revisar.");
  const config=makeConfig(db.uuid,template);
  writeFileSync(file,JSON.stringify(config,null,2)+"\n",{flag:"wx",mode:0o600});
  const env={...process.env,CI:"true",CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId,
    CLOUDFLARE_SEND_METRICS:"false",WRANGLER_SEND_METRICS:"false"};
  const cli=resolve(root,"node_modules/wrangler/bin/wrangler.js");
  const wrangler=(...args)=>run(process.execPath,[cli,...args,"--config",file],{cwd:root,env,stdio:"inherit",timeout:180000});
  // Migrações SOMENTE no banco NOVO, vazio e identificado acima.
  wrangler("d1","migrations","apply",NAMES.database,"--remote");
  wrangler("deploy");
  for(const secret of ["SESSION_SECRET","MSG_ENC_KEY"]) {
    run(process.execPath,[cli,"secret","put",secret,"--config",file],{
      cwd:root,env,input:randomBytes(48).toString("hex")+"\n",
      stdio:["pipe","inherit","inherit"],timeout:60000,
    });
  }
  const after=await api("GET",rootApi+"/workers/scripts");
  if(matches(after,"id",NAMES.worker).length!==1)
    throw Error("Worker novo não apareceu na Cloudflare.");
  const postDomains=await api("GET",rootApi+"/workers/domains");
  if(!postDomains.some(x=>x?.hostname===NAMES.domain && x?.service==="tigu-staging" && x.enabled))
    throw Error("ALERTA: rota do domínio oficial mudou inesperadamente, investigar.");
  return {...verified,worker:NAMES.worker,db_created:true,r2_created:true,
    migrations_only_new_db:true,manual_billing:true,
    secrets:["SESSION_SECRET","MSG_ENC_KEY"],official_route_preserved:true,
    api_host:NAMES.publicHost,production_modified:false};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==2||process.env.GITHUB_ACTIONS!=="true"||
      process.env.GITHUB_EVENT_NAME!=="push"||
      process.env.GITHUB_REPOSITORY!=="rykellmy31-star/GESTOR-BARBEARIA"||
      process.env.GITHUB_REF!=="refs/heads/feature/tigu-mensalidade-manual-preintegracao-20261028"||
      process.env.TIGU_ISOLATED_DEPLOY_APPROVED!=="YES")
      throw Error("Execução única de homologação não autorizada.");
    const result=await deployIsolated({
      token:process.env.CLOUDFLARE_STAGING_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    });
    console.log("TIGU — Publicação ISOLADA: "+JSON.stringify(result,null,2));
  }catch(err){
    console.error("TIGU — publicação isolada bloqueada: "+(err instanceof Error?err.message:String(err)));
    process.exitCode=1;
  }
}
