#!/usr/bin/env node
/**
 * Evidência de backup D1 REAL da Cloudflare, SOMENTE HOMOLOGAÇÃO:
 * - descobre o UUID do tigu-staging-db por GET
 * - exporta SQL pelo Wrangler, sem escrever no D1
 * - importa em SQLite TEMPORÁRIO e compara integridade, FKs e tabelas
 * - remove dump/arquivos antes de sair (nunca vira GitHub artifact).
 *
 * Ainda NÃO confirma restore dentro da Cloudflare nem inclui bucket R2.
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { auditD1Export } from "./backup-evidence.mjs";
import { stagingConfigIssues } from "./staging-config.mjs";

const ID = /^[0-9a-f]{32}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API="https://api.cloudflare.com/client/v4";
const DATABASE="tigu-staging-db";
const R2="tigu-staging-media";
const WORKER="tigu-staging";

export async function inspectExportTarget({ token, accountId, fetcher=fetch }) {
  if (typeof token!=="string" || token.length<15) throw Error("CLOUDFLARE_STAGING_TOKEN ausente.");
  if (!ID.test(accountId||"")) throw Error("CLOUDFLARE_ACCOUNT_ID inválido.");
  const base="/accounts/"+accountId;
  async function get(path){
    const response=await fetcher(API+path,{method:"GET",redirect:"error",
      signal:AbortSignal.timeout(15000),
      headers:{Authorization:"Bearer "+token,Accept:"application/json"}});
    if(!response.ok) throw Error("Cloudflare não permitiu conferir os recursos staging ("+response.status+").");
    const value=await response.json();
    if(value?.success!==true) throw Error("Cloudflare recusou o inventário.");
    return value.result;
  }
  const dbs=await get(base+"/d1/database?name="+DATABASE);
  const buckets=await get(base+"/r2/buckets?name_contains="+R2);
  const workers=await get(base+"/workers/scripts");
  const d=Array.isArray(dbs)?dbs.filter(x=>x?.name===DATABASE):[];
  const b=Array.isArray(buckets?.buckets)?buckets.buckets.filter(x=>x?.name===R2):[];
  const w=Array.isArray(workers)?workers.filter(x=>x?.id===WORKER):[];
  if(d.length!==1 || !UUID.test(d[0]?.uuid||"")||b.length!==1||w.length!==1)
    throw Error("Inventário staging incompleto ou ambíguo; exportação bloqueada.");
  return d[0].uuid;
}

export async function exportAndCheckStaging({
  token, accountId, fetcher=fetch, exec=execFileSync, root=resolve(import.meta.dirname,".."),
}) {
  const databaseId=await inspectExportTarget({token,accountId,fetcher});
  const config=JSON.parse(readFileSync(join(root,"wrangler.staging.template.jsonc"),"utf8"));
  const original=JSON.parse(readFileSync(join(root,"wrangler.jsonc"),"utf8"));
  config.d1_databases[0].database_id=databaseId;
  const issues=stagingConfigIssues(config,original);
  if(issues.length) throw Error("Configuração não isolada: "+issues.join("; "));
  const temp=mkdtempSync(join(tmpdir(),"tigu-d1-export-"));
  try {
    const conf=join(temp,"wrangler.staging.jsonc");
    const dump=join(temp,"d1-export.sql");
    writeFileSync(conf,JSON.stringify(config),{mode:0o600,flag:"wx"});
    const environment={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId};
    try {
      // --output recebe caminho completo temporário. O comando não importa,
      // executa SQL, restaura ou altera recursos remotos.
      exec("npx",["wrangler","d1","export",DATABASE,"--remote",
        "--config",conf,"--output",dump],{
          cwd:root,env:environment,stdio:"pipe",timeout:180000,maxBuffer:2*1024*1024,
        });
    } catch {
      throw Error("Exportação D1 Cloudflare falhou (confira escopo de leitura e configuração).");
    }
    chmodSync(dump,0o600);
    const sql=readFileSync(dump,"utf8");
    const stats=auditD1Export(sql);
    const sha256=createHash("sha256").update(sql).digest("hex");
    return {
      source:"cloudflare-d1-staging", database:DATABASE,
      sql_exported:true,local_sqlite_restore_verified:true,
      integrity:stats.integrity,foreign_keys:stats.foreign_keys,
      essential_tables:stats.essential_tables,counts:stats.counts,
      sha256, dump_persisted:false,cloudflare_restore_verified:false,r2_backup_verified:false,
    };
  }finally{
    rmSync(temp,{recursive:true,force:true});
  }
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==2||process.env.GITHUB_ACTIONS!=="true"||
      process.env.GITHUB_EVENT_NAME!=="push"||
      process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
      process.env.TIGU_D1_EXPORT_APPROVED!=="YES")
      throw Error("Verificação de exportação D1 exige push TIGU autorizado.");
    const result=await exportAndCheckStaging({
      token:process.env.CLOUDFLARE_STAGING_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    });
    console.log("TIGU — evidência export D1 staging:\n"+JSON.stringify(result,null,2));
    console.log("SQL descartado; nenhum arquivo de cliente foi publicado.");
  }catch(err){
    console.error("TIGU export D1: "+(err instanceof Error?err.message:String(err)));
    process.exitCode=1;
  }
}
