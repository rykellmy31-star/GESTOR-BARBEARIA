#!/usr/bin/env node
/**
 * Compara somente as bases STAGING existentes por export SQL de leitura.
 * Não cria/importa/aplica SQL remotamente, não faz deploy e não expõe dados.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync,readFileSync,writeFileSync,rmSync,chmodSync } from "node:fs";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { inspectExportTarget } from "./staging-d1-export-verify.mjs";
import { sqlFingerprint } from "./staging-d1-remote-restore.mjs";
import { stagingConfigIssues } from "./staging-config.mjs";

const DEST="tigu-staging-restore-check",SOURCE="tigu-staging-db";
const UUID=/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const requiredTables=["booking_payments","order_payments","company_payment_integrations"];

function schemaReport(sql){
 const db=new DatabaseSync(":memory:");
 try{
  db.exec(sql);
  const names=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r=>r.name));
  return {required_checkout_tables_present:requiredTables.every(x=>names.has(x))};
 }finally{db.close();}
}
export async function compareExistingStagingD1({token,accountId,fetcher=fetch,
 exec=execFileSync,root=resolve(import.meta.dirname,"..")}){
 const sourceId=await inspectExportTarget({token,accountId,fetcher});
 const api="https://api.cloudflare.com/client/v4/accounts/"+accountId+
   "/d1/database?name="+DEST;
 const r=await fetcher(api,{method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
  headers:{Authorization:"Bearer "+token,Accept:"application/json"}});
 if(!r.ok)throw Error("Consulta D1 de recuperação negada ("+r.status+").");
 const j=await r.json();
 if(j?.success!==true||!Array.isArray(j.result))
  throw Error("Inventário do D1 de recuperação inválido.");
 const destinations=j.result.filter(x=>x?.name===DEST);
 if(destinations.length!==1||!UUID.test(destinations[0].uuid)||destinations[0].uuid===sourceId)
  throw Error("Destino de recuperação D1 ausente, ambíguo ou igual à origem.");
 const template=JSON.parse(readFileSync(join(root,"wrangler.staging.template.jsonc"),"utf8"));
 const prod=JSON.parse(readFileSync(join(root,"wrangler.jsonc"),"utf8"));
 template.d1_databases[0].database_id=sourceId;
 if(stagingConfigIssues(template,prod).length)
  throw Error("Contrato de staging inválido: leitura bloqueada.");
 const temp=mkdtempSync(join(tmpdir(),"tigu-compare-d1-"));
 const env={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId};
 try{
  function exportDatabase(dbname,dbid,filename){
   const cfg=structuredClone(template);
   cfg.d1_databases[0].database_id=dbid;
   cfg.d1_databases[0].database_name=dbname;
   cfg.name=dbname===SOURCE?"tigu-staging":"tigu-staging-readonly-restore";
   const configPath=join(temp,"config-"+filename+".jsonc");
   const sqlPath=join(temp,filename+".sql");
   writeFileSync(configPath,JSON.stringify(cfg),{mode:0o600,flag:"wx"});
   // Exposição de comandos restrita ao export read-only.
   try{
    exec("npx",["wrangler","d1","export",dbname,"--remote","--config",configPath,
      "--output",sqlPath],{cwd:root,env,stdio:"pipe",timeout:240000,maxBuffer:1024*1024});
   }catch{throw Error("Exportação de leitura do D1 "+filename+" falhou.");}
   chmodSync(sqlPath,0o600);
   const sql=readFileSync(sqlPath,"utf8");
   if(sql.length>20*1024*1024)throw Error("Exportação maior que limite seguro de 20 MB.");
   return sql;
  }
  const source=exportDatabase(SOURCE,sourceId,"source");
  const sourceFingerprint=sqlFingerprint(source);
  const sourceSchema=schemaReport(source);
  if(!sourceSchema.required_checkout_tables_present)
   throw Error("Banco de staging não tem esquema financeiro 0018/0019.");
  const target=exportDatabase(DEST,destinations[0].uuid,"target");
  let targetFingerprint,targetSchema;
  try{
   targetSchema=schemaReport(target);
   targetFingerprint=sqlFingerprint(target);
  }catch{
   return {source:SOURCE,destination:DEST,source_checkout_schema_complete:true,
    destination_checkout_schema_complete:false,
    cloudflare_restore_verified:false,source_unchanged:true,production_modified:false,
    remote_writes:0,resources_created:false,
    reason:"D1 de recuperação não contém cópia íntegra e válida do staging."};
  }
  const identical=sourceFingerprint.sha256===targetFingerprint.sha256 &&
    sourceFingerprint.table_count===targetFingerprint.table_count &&
    targetSchema.required_checkout_tables_present;
  return {
   source:SOURCE,destination:DEST,source_checkout_schema_complete:true,
   destination_checkout_schema_complete:targetSchema.required_checkout_tables_present,
   source_tables:sourceFingerprint.table_count,destination_tables:targetFingerprint.table_count,
   fingerprints_match:identical,cloudflare_restore_verified:identical,
   remote_writes:0,resources_created:false,source_unchanged:true,production_modified:false,
   ...(identical?{}:{reason:"D1 destino difere do atual staging; restauração remota NÃO homologada."}),
  };
 }finally{rmSync(temp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.env.GITHUB_ACTIONS!=="true"||
    process.env.GITHUB_EVENT_NAME!=="push"||
    process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
    process.env.TIGU_D1_COMPARE_APPROVED!=="YES")
   throw Error("Comparação de recuperação exige push staging autorizado.");
  console.log("TIGU DR D1 comparação somente leitura: "+JSON.stringify(await compareExistingStagingD1({
   token:process.env.CLOUDFLARE_STAGING_TOKEN,
   accountId:process.env.CLOUDFLARE_ACCOUNT_ID
  }),null,2));
 }catch(e){console.error("TIGU DR D1 read-only: "+(e instanceof Error?e.message:String(e)));process.exitCode=1;}
}
