#!/usr/bin/env node
/**
 * Exclusivamente D1 remoto tigu-staging-db; aplica migrações já versionadas.
 * Requer inventário Cloudflare correto e branch/commit-gatilho autorizado.
 * Não provisiona recursos, não toca em produção nem recria secrets.
 */
import {existsSync,readFileSync} from "node:fs";
import {resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {pathToFileURL} from "node:url";
import {inspectExportTarget} from "./staging-d1-export-verify.mjs";
import {stagingConfigIssues} from "./staging-config.mjs";

export async function migrateBookingStaging({token,accountId,root=process.cwd(),exec=execFileSync}){
  if(typeof token!=="string"||token.length<15||!(/^[0-9a-f]{32}$/i).test(accountId||""))
    throw Error("Token ou conta de staging inválidos.");
  if(existsSync(resolve(root,"wrangler.staging.jsonc")))throw Error("Configuração staging presente; não substituir.");
  const databaseId=await inspectExportTarget({token,accountId});
  const config=JSON.parse(readFileSync(resolve(root,"wrangler.staging.template.jsonc"),"utf8"));
  const production=JSON.parse(readFileSync(resolve(root,"wrangler.jsonc"),"utf8"));
  config.d1_databases[0].database_id=databaseId;
  if(stagingConfigIssues(config,production).length||config.name!=="tigu-staging")
    throw Error("Isolamento do D1 não confirmado.");
  const env={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId};
  function run(...args){exec(process.execPath,args,{cwd:root,env,stdio:"inherit"});}
  run("scripts/staging.mjs","prepare","--database-id",databaseId);
  run("scripts/staging.mjs","validate");
  // Wrangler/D1 registra migrações previamente aplicadas: somente as pendentes avançam.
  run("scripts/staging.mjs","migrate");
  return {database:"tigu-staging-db",migrations_applied_to_staging_only:true,
    worker_updated:false,production_modified:false,resources_created:false};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.argv.length!==2||process.env.GITHUB_ACTIONS!=="true"||
      process.env.GITHUB_EVENT_NAME!=="push"||
      process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
      process.env.TIGU_BOOKING_MIGRATION_APPROVED!=="YES")
      throw Error("Migração de homologação requer push-gatilho autorizado.");
    console.log("TIGU staging D1 migration: "+JSON.stringify(await migrateBookingStaging({
      token:process.env.CLOUDFLARE_STAGING_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID
    })));
  }catch(e){
    console.error("TIGU staging D1 migration: "+(e instanceof Error?e.message:String(e)));
    process.exitCode=1;
  }
}
