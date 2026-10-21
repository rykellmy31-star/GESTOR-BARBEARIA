#!/usr/bin/env node
/**
 * Disaster-recovery drill somente Cloudflare TIGU STAGING.
 * Exporta o D1 staging e IMPORTA em um D1 RESTORE NOVO E SEPARADO.
 * Nunca toca um D1 existente, nem base de produção. Dados temporários não
 * são anexados a jobs nem escritos nos logs; ambos os dumps são apagados.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from "node:fs";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { auditD1Export } from "./backup-evidence.mjs";
import { inspectExportTarget } from "./staging-d1-export-verify.mjs";
import { stagingConfigIssues } from "./staging-config.mjs";

const ACCOUNT=/^[0-9a-f]{32}$/i;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const SOURCE="tigu-staging-db";
const RESTORE="tigu-staging-restore-check";
const API="https://api.cloudflare.com/client/v4";
const ALLOWED_TABLE=/^[a-zA-Z_][a-zA-Z0-9_]*$/;

export function sqlFingerprint(sql) {
  auditD1Export(sql);
  const db=new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    const names=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != '_cf_KV' ORDER BY name")
      .all().map(x=>x.name);
    const digest=createHash("sha256");
    for(const name of names) {
      if(!ALLOWED_TABLE.test(name))throw Error("Tabela SQL não identificada.");
      const rows=db.prepare('SELECT * FROM "'+name+'"').all().map(r=>JSON.stringify(r)).sort();
      digest.update(name+"\n"+rows.length+"\n");
      for(const r of rows)digest.update(r+"\n");
    }
    return { table_count:names.length,sha256:digest.digest("hex") };
  }finally{db.close();}
}
export async function newIsolatedRestore({token,accountId,sourceId,fetcher=fetch}) {
  if(typeof token!=="string"||token.length<15||!ACCOUNT.test(accountId||"")||!UUID.test(sourceId||""))
    throw Error("Credenciais ou banco de staging inválidos.");
  const base="/accounts/"+accountId;
  const auth={Authorization:"Bearer "+token,Accept:"application/json"};
  async function api(method,path,payload) {
    if(!(method==="GET"&&path===base+"/d1/database?name="+RESTORE ||
         method==="POST"&&path===base+"/d1/database"&&payload?.name===RESTORE&&Object.keys(payload).length===1))
      throw Error("Rota de restauração fora do escopo permitido.");
    const res=await fetcher(API+path,{method,redirect:"error",signal:AbortSignal.timeout(20000),
      headers:{...auth,...(payload?{"Content-Type":"application/json"}:{})},
      ...(payload?{body:JSON.stringify(payload)}:{})});
    if(!res.ok)throw Error("API Cloudflare negou "+method+" de D1 restore ("+res.status+").");
    const json=await res.json();
    if(json?.success!==true)throw Error("Cloudflare recusou D1 restore.");
    return json.result;
  }
  const existing=await api("GET",base+"/d1/database?name="+RESTORE);
  if(!Array.isArray(existing)||existing.some(x=>x?.name===RESTORE))
    throw Error("D1 de restore já existe ou inventário inválido: recusar sobrescrita.");
  const created=await api("POST",base+"/d1/database",{name:RESTORE});
  if(created?.name!==RESTORE||!UUID.test(created?.uuid||"")||created.uuid===sourceId)
    throw Error("Cloudflare criou destino com ID incompatível, restauração bloqueada.");
  return created.uuid;
}
export async function runD1RemoteRecovery({
  token,accountId,fetcher=fetch,execute=execFileSync,root=resolve(import.meta.dirname,".."),
}) {
  const sourceId=await inspectExportTarget({token,accountId,fetcher});
  const template=JSON.parse(readFileSync(join(root,"wrangler.staging.template.jsonc"),"utf8"));
  const production=JSON.parse(readFileSync(join(root,"wrangler.jsonc"),"utf8"));
  template.d1_databases[0].database_id=sourceId;
  if(stagingConfigIssues(template,production).length)throw Error("Origem de backup não isolada.");
  const env={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId};
  const tmp=mkdtempSync(join(tmpdir(),"tigu-restore-d1-"));
  try {
    const sourceCfg=join(tmp,"source.jsonc"),restoreCfg=join(tmp,"restore.jsonc");
    const original=join(tmp,"source.sql"),roundtrip=join(tmp,"roundtrip.sql");
    writeFileSync(sourceCfg,JSON.stringify(template),{mode:0o600,flag:"wx"});
    const run=(args)=>{
      try{return execute("npx",["wrangler","d1",...args],{
        cwd:root,env,stdio:"pipe",timeout:240000,maxBuffer:1024*1024,
      });}
      catch{throw Error("Falha Wrangler D1 isolado, consultar logs sem publicar dados.");}
    };
    run(["export",SOURCE,"--remote","--config",sourceCfg,"--output",original]);
    const sql=readFileSync(original,"utf8");
    if(sql.length>20*1024*1024)throw Error("Exportação D1 maior que o limite seguro de 20 MB para o ensaio.");
    const originalAudit=auditD1Export(sql);
    const originalFingerprint=sqlFingerprint(sql);
    // Só depois de validar export e destino ausente permitimos CRIAR um D1
    // de restauro. NUNCA usamos import/execute contra o D1 original.
    const restoreId=await newIsolatedRestore({token,accountId,sourceId,fetcher});
    const cfg={
      name:"tigu-staging-restore-only",main:"api/index.ts",
      compatibility_date:"2025-01-01",
      d1_databases:[{binding:"DB",database_name:RESTORE,database_id:restoreId}],
    };
    if(cfg.d1_databases[0].database_name!==RESTORE||cfg.d1_databases[0].database_id===sourceId)
      throw Error("Tentativa de restaurar no banco de origem.");
    writeFileSync(restoreCfg,JSON.stringify(cfg),{mode:0o600,flag:"wx"});
    run(["execute",RESTORE,"--remote","--yes","--config",restoreCfg,"--file",original]);
    run(["export",RESTORE,"--remote","--config",restoreCfg,"--output",roundtrip]);
    const recovered=readFileSync(roundtrip,"utf8");
    const recoveredAudit=auditD1Export(recovered);
    const recoveredFingerprint=sqlFingerprint(recovered);
    if(originalFingerprint.sha256!==recoveredFingerprint.sha256 ||
      originalFingerprint.table_count!==recoveredFingerprint.table_count ||
      JSON.stringify(originalAudit.counts)!==JSON.stringify(recoveredAudit.counts))
      throw Error("Restauração remota D1 não reproduziu os registros originais.");
    return {
      source:SOURCE,restored_to:RESTORE,cloudflare_restore_verified:true,
      tables:originalFingerprint.table_count,checksums_match:true,
      counts:recoveredAudit.counts,
      source_integrity:"ok",restored_integrity:"ok",
      source_unchanged:true,production_unchanged:true,
      dumps_deleted:true,r2_restore_verified:false,
    };
  }finally{rmSync(tmp,{recursive:true,force:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if(process.env.GITHUB_ACTIONS!=="true"||process.env.GITHUB_EVENT_NAME!=="push"||
       process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
       process.env.TIGU_REMOTE_D1_RESTORE_APPROVED!=="YES"||process.argv.length!==2)
      throw Error("Restauração remota exigiu push autorizado.");
    const x=await runD1RemoteRecovery({
      token:process.env.CLOUDFLARE_STAGING_TOKEN,accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    });
    console.log("TIGU Disaster Recovery D1: "+JSON.stringify(x,null,2));
  } catch(err) {
    console.error("Falha no restore D1 staging: "+(err instanceof Error?err.message:String(err)));
    process.exitCode=1;
  }
}
