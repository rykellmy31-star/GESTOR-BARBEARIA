#!/usr/bin/env node
/** Provisiona SOMENTE os nomes D1/R2 reservados da produção TIGU.
 * Não cria Worker executável: sem credenciais independentes, migração e
 * verificação de pagamentos, publicar a API em produção seria inseguro.
 * Não altera domínio, staging, DNS, secrets nem dados existentes.
 */
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";
import {
 auditProductionResources,PRODUCTION
} from "./production-inventory-readonly.mjs";
const base="https://api.cloudflare.com/client/v4";
export async function createProductionResources({token,accountId,fetcher=fetch,audit=auditProductionResources}={}){
 const ready=await audit({token,accountId,fetcher});
 if(ready.staging_verified!==true||ready.production_targets_absent!==true||
    ready.domain_still_on_staging!==true)
   throw Error("Preflight de produção inválido; nenhuma criação permitida.");
 const url=base+"/accounts/"+accountId;
 async function create(path,name){
  const resp=await fetcher(url+path,{
   method:"POST",redirect:"error",signal:AbortSignal.timeout(25000),
   headers:{"Authorization":"Bearer "+token,
     "Content-Type":"application/json","Accept":"application/json"},
   body:JSON.stringify({name})
  });
  if(!resp.ok)throw Error("Cloudflare não autorizou a criação de "+name+" (HTTP "+resp.status+"). Inspecione o painel antes de repetir.");
  const payload=await resp.json();
  if(payload?.success!==true||payload.result?.name!==name)
   throw Error("Resposta inesperada ao criar "+name+". Verifique manualmente antes de repetir.");
  return payload.result;
 }
 // Criação sequencial: se falhar D1, não cria o R2.
 const db=await create("/d1/database",PRODUCTION.d1);
 if(!/^[0-9a-f-]{36}$/i.test(db.uuid||""))
  throw Error("D1 criado, porém UUID inesperado. Não criar R2 nem reexecutar automaticamente.");
 await create("/r2/buckets",PRODUCTION.r2);
 return {
  d1_created:true,r2_created:true,
  production_worker_created:false,domain_changed:false,
  staging_modified:false,production_payments_enabled:false,
  whatsapp_messages_enabled:false,db_migrations_applied:false,
  note:"D1 e R2 de produção vazios. Worker ainda NÃO deve ser publicado sem secrets independentes e migrações."
 };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.env.GITHUB_ACTIONS!=="true"||
     process.env.GITHUB_EVENT_NAME!=="push"||
     process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
     process.env.GITHUB_REPOSITORY!=="rykellmy31-star/GESTOR-BARBEARIA"||
     process.env.TIGU_PRODUCTION_RESOURCES_APPROVED!=="YES"||
     process.argv.length!==2)
    throw Error("Requer autorização específica e push de commit único.");
  const out=await createProductionResources({
   token:process.env.CLOUDFLARE_STAGING_TOKEN,
   accountId:process.env.CLOUDFLARE_ACCOUNT_ID
  });
  console.log("TIGU isolated production resources: "+JSON.stringify(out));
 }catch(e){
  console.error("TIGU production provision: "+(e instanceof Error?e.message:"Erro não identificado."));
  process.exitCode=1;
 }
}
