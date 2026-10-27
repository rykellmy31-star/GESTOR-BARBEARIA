#!/usr/bin/env node
/**
 * R2 DR inventory: somente GET com paginação. Nenhum nome de objeto,
 * metadado pessoal, token ou chave é impresso no log.
 */
import { inspectExportTarget } from "./staging-d1-export-verify.mjs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SOURCE="tigu-staging-media";
const DEST="tigu-recovery-20261021-39699187805-r2";
const API="https://api.cloudflare.com/client/v4/accounts/";
const MAX_PAGES=100,PER_PAGE=100;

export async function inventoryR2({token,accountId,fetcher=fetch}) {
  await inspectExportTarget({token,accountId,fetcher});
  if(!/^[0-9a-f]{32}$/i.test(accountId||"") || typeof token!=="string" || token.length<15)
    throw Error("Credenciais de staging ausentes ou inválidas.");
  async function scan(bucket){
    let total=0,bytes=0,pages=0,cursor="",completed=false;
    const seen=new Set();
    while(pages<MAX_PAGES){
      const params=new URLSearchParams({per_page:String(PER_PAGE)});
      if(cursor)params.set("cursor",cursor);
      const url=API+accountId+"/r2/buckets/"+bucket+"/objects?"+params;
      let response;
      try{
        response=await fetcher(url,{method:"GET",redirect:"error",
         headers:{Authorization:"Bearer "+token,Accept:"application/json"},
         signal:AbortSignal.timeout(25000)});
      }catch{throw Error("Inventário R2 remoto indisponível.");}
      if(!response.ok)throw Error("Cloudflare R2 recusou inventário "+bucket+" (HTTP "+response.status+").");
      const body=await response.json();
      if(body?.success!==true || !Array.isArray(body.result))
        throw Error("Cloudflare R2 retornou inventário incompleto ou inesperado.");
      for(const obj of body.result){
        // Evitar vazamento de chaves, rejeitar lista de objetos incompletos.
        if(typeof obj?.key!=="string"||!obj.key||!Number.isSafeInteger(obj?.size)||obj.size<0)
          throw Error("Metadados de objeto R2 inválidos.");
        total++;
        bytes+=obj.size;
        if(!Number.isSafeInteger(bytes))throw Error("Total R2 excede precisão numérica.");
      }
      pages++;
      const info=body.result_info;
      if(info?.is_truncated!==true){
        if(info?.is_truncated!==false && body.result.length>=PER_PAGE)
          throw Error("Paginação incompleta: impossível garantir inventário R2.");
        completed=true;break;
      }
      if(typeof info.cursor!=="string"||!info.cursor||seen.has(info.cursor))
        throw Error("Cursor da paginação R2 ausente ou repetido.");
      seen.add(info.cursor);cursor=info.cursor;
    }
    return {objects:total,bytes,pages,complete:completed};
  }
  const source=await scan(SOURCE);
  const recovery=await scan(DEST);
  return {
    staging_source:SOURCE,recovery_destination:DEST,
    source,recovery,
    // A cópia de prova não equivale à cópia de todas as imagens dos clientes.
    complete_inventory_verified:source.complete&&recovery.complete,
    all_source_objects_restored:false,
    remote_writes:0,resources_created:0,production_modified:false,
  };
}

if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.env.GITHUB_ACTIONS!=="true"||
       process.env.GITHUB_EVENT_NAME!=="push"||
       process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
       process.env.TIGU_R2_INVENTORY_APPROVED!=="YES"||
       process.argv.length!==2)
      throw Error("Inventário R2 autorizado somente por gatilho de staging.");
    const report=await inventoryR2({
      token:process.env.CLOUDFLARE_STAGING_TOKEN,
      accountId:process.env.CLOUDFLARE_ACCOUNT_ID
    });
    console.log("TIGU inventário R2 somente leitura: "+JSON.stringify(report,null,2));
    if(!report.complete_inventory_verified)throw Error("Inventário R2 incompleto: falha fechada.");
  }catch(e){
    console.error("Falha no inventário R2 read-only: "+(e instanceof Error?e.message:String(e)));
    process.exitCode=1;
  }
}
