#!/usr/bin/env node
/**
 * Pré-inspeção de DR. Exclusivamente GET Cloudflare, sem criar,
 * restaurar, deletar ou sobrescrever D1/R2. Nunca imprime tokens.
 */
import { inspectExportTarget } from "./staging-d1-export-verify.mjs";
const DATABASE="tigu-staging-restore-check";
const BUCKET="tigu-staging-restore-check";
export async function inspectRestoreTargets({token,accountId,fetcher=fetch}) {
  const sourceId=await inspectExportTarget({token,accountId,fetcher});
  const base="https://api.cloudflare.com/client/v4/accounts/"+accountId;
  async function list(path) {
    const r=await fetcher(base+path,{method:"GET",redirect:"error",
      headers:{Authorization:"Bearer "+token,Accept:"application/json"},
      signal:AbortSignal.timeout(15000)});
    if(!r.ok)throw Error("Inspeção read-only negada ("+r.status+").");
    const j=await r.json();
    if(j?.success!==true)throw Error("Resposta Cloudflare inválida.");
    return j.result;
  }
  const [dbs,buckets]=await Promise.all([
    list("/d1/database?name="+DATABASE),
    list("/r2/buckets?name_contains="+BUCKET)
  ]);
  if(!Array.isArray(dbs)||!Array.isArray(buckets?.buckets))
    throw Error("Inventário DR incompleto: não autorizar restauração.");
  const matchedDb=dbs.filter(x=>x?.name===DATABASE);
  const matchedBucket=buckets.buckets.filter(x=>x?.name===BUCKET);
  if(matchedDb.length>1||matchedBucket.length>1)
    throw Error("Inventário DR ambíguo; bloquear restauração.");
  const db=matchedDb[0],bucket=matchedBucket[0];
  if(db && db.uuid===sourceId)throw Error("Destino D1 aponta para origem: bloquear.");
  return {
    staging_source_verified:true,
    d1_restore_destination_exists:Boolean(db),
    r2_restore_destination_exists:Boolean(bucket),
    d1_destination_overwrite_refused:Boolean(db),
    r2_destination_overwrite_refused:Boolean(bucket),
    remote_restore_attempted:false,
    resources_created:false,
    production_modified:false,
    next_action:db||bucket
      ?"Destinos de restauração já existem; não sobrescrever. Exige estratégia de destino novo e autorização de custos."
      :"Destinos ausentes; criação/restauração exige autorização específica para possíveis custos."
  };
}
if(process.argv[1] && import.meta.url===new URL("file://"+process.argv[1]).href){
  try {
    if(process.env.GITHUB_ACTIONS!=="true"||
      process.env.GITHUB_EVENT_NAME!=="push"||
      process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
      process.env.TIGU_DR_INVENTORY_APPROVED!=="YES")
      throw Error("Inventário DR requer push autorizado.");
    const out=await inspectRestoreTargets({
      token:process.env.CLOUDFLARE_STAGING_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID
    });
    console.log("TIGU DR inventário read-only: "+JSON.stringify(out,null,2));
  }catch(err){
    console.error("Inventário DR: "+(err instanceof Error?err.message:String(err)));
    process.exitCode=1;
  }
}
