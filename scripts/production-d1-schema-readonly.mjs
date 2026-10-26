#!/usr/bin/env node
/** Verificação do banco de produção SOMENTE com SQL SELECT fixo.
 * POST de query da Cloudflare executa unicamente leitura, nenhum DML/DDL.
 * Imprime apenas contagens, sem dados, tokens, IDs, segredos ou SQL arbitrário.
 */
const env=process.env;
const ACCOUNT=/^[a-f0-9]{32}$/i;
async function safeJson(response,what){
 if(!response.ok)throw Error(what+": HTTP "+response.status);
 const j=await response.json();
 if(j?.success!==true)throw Error(what+": Cloudflare retornou erro.");
 return j.result;
}
async function main(){
 if(env.GITHUB_ACTIONS!=="true"||env.GITHUB_EVENT_NAME!=="push"||
  env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
  env.TIGU_PRODUCTION_DB_READONLY_APPROVED!=="YES")throw Error("Execução fora da autorização.");
 if(!env.CLOUDFLARE_PRODUCTION_TOKEN||env.CLOUDFLARE_PRODUCTION_TOKEN.length<15||
    !ACCOUNT.test(env.CLOUDFLARE_ACCOUNT_ID||""))throw Error("Credencial de produção indisponível.");
 const u="https://api.cloudflare.com/client/v4/accounts/"+env.CLOUDFLARE_ACCOUNT_ID;
 const headers={Authorization:"Bearer "+env.CLOUDFLARE_PRODUCTION_TOKEN,Accept:"application/json"};
 const dbs=await safeJson(await fetch(u+"/d1/database?name=tigu-production-db",{
  method:"GET",redirect:"error",headers,signal:AbortSignal.timeout(12000)
 }),"Listar D1");
 if(!Array.isArray(dbs))throw Error("Resposta D1 inesperada.");
 const matches=dbs.filter(x=>x?.name==="tigu-production-db");
 if(matches.length!==1||!/^[a-f0-9-]{36}$/i.test(matches[0]?.uuid||""))
  throw Error("Banco de produção ausente, duplicado ou inválido.");
 const endpoint=u+"/d1/database/"+matches[0].uuid+"/query";
 // SQL fixo, apenas contagens e nomes de tabelas públicas do esquema:
 const sql="SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name";
 const queried=await safeJson(await fetch(endpoint,{
  method:"POST",redirect:"error",signal:AbortSignal.timeout(18000),
  headers:{...headers,"Content-Type":"application/json"},
  body:JSON.stringify({sql})
 }),"Ler esquema D1");
 const rows=Array.isArray(queried)?queried[0]?.results:null;
 if(!Array.isArray(rows))throw Error("Cloudflare não retornou lista de tabelas.");
 const names=rows.map(x=>x?.name).filter(x=>typeof x==="string");
 if(names.length!==rows.length)throw Error("Lista incompleta de tabelas.");
 // Evita vazar nomes de tabelas customizadas/caso a base não seja do TIGU.
 console.log("TIGU_PRODUCTION_D1_SCHEMA_READ_ONLY",JSON.stringify({
  table_count:names.length,has_companies:names.includes("companies"),
  has_bookings:names.includes("bookings"),
  has_booking_payments:names.includes("booking_payments"),
  has_seller_mp_accounts:names.includes("seller_mp_accounts"),
  has_d1_migrations:names.includes("d1_migrations"),
  empty_database:names.length===0
 }));
 console.log("Nenhuma migração aplicada, nenhum registro modificado.");
}
main().catch(e=>{console.error("TIGU_PRODUCTION_D1_SCHEMA_READ_ONLY:",e instanceof Error?e.message:"falha de leitura");process.exitCode=1});
