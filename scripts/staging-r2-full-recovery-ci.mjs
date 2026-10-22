#!/usr/bin/env node
/**
 * Recuperação COMPLETA e delimitada do pequeno acervo R2 TIGU STAGING.
 * Criar bucket novo e comparar bytes. Nunca imprime nomes/metadados privados.
 * Sem acesso a arquivos/buckets de produção e sem sobrescrever nenhum recurso.
 */
import { createHash } from "node:crypto";
import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { inspectExportTarget } from "./staging-d1-export-verify.mjs";

const SOURCE="tigu-staging-media";
const BASE="https://api.cloudflare.com/client/v4/accounts/";
const MAX_OBJECTS=500,MAX_BYTES=50*1024*1024,MAX_PAGES=20,PER_PAGE=100;
const sha=v=>createHash("sha256").update(v).digest("hex");
const keyOk=k=>typeof k==="string"&&k.length>0&&k.length<=1024&&
  !/[\0-\x1f\x7f]/.test(k)&&!k.startsWith("/");
const mimeOk=v=>typeof v==="string"&&/^[\w.+-]+\/[\w.+-]+$/.test(v);

async function listObjects({accountId,token,bucket,fetcher}) {
 const all=[],cursors=new Set();
 let cursor="",done=false;
 for(let i=0;i<MAX_PAGES;i++){
  const query=new URLSearchParams({per_page:String(PER_PAGE)});
  if(cursor)query.set("cursor",cursor);
  const url=BASE+accountId+"/r2/buckets/"+bucket+"/objects?"+query;
  let response;
  try{
   response=await fetcher(url,{method:"GET",redirect:"error",
    headers:{Authorization:"Bearer "+token,Accept:"application/json"},
    signal:AbortSignal.timeout(25000)});
  }catch{throw Error("Cloudflare indisponível durante listagem de recuperação R2.");}
  if(!response.ok)throw Error("Cloudflare negou listagem R2 (HTTP "+response.status+").");
  const body=await response.json();
  if(body?.success!==true||!Array.isArray(body.result))
   throw Error("Listagem R2 incompleta ou de formato inválido.");
  for(const row of body.result){
   if(!keyOk(row?.key)||!Number.isSafeInteger(row?.size)||row.size<0||
      row.size>MAX_BYTES||row.ssec===true)
    throw Error("Objeto R2 não suportado neste ensaio seguro.");
   if(all.some(x=>x.key===row.key))throw Error("Duplicação na listagem R2.");
   all.push({key:row.key,size:row.size,etag:row.etag??null,
     mime:mimeOk(row.http_metadata?.contentType)?row.http_metadata.contentType:null});
   if(all.length>MAX_OBJECTS||all.reduce((n,x)=>n+x.size,0)>MAX_BYTES)
    throw Error("Volume R2 maior que limite de segurança; não criar bucket.");
  }
  const info=body.result_info;
  if(info?.is_truncated!==true){
   if(info?.is_truncated!==false&&body.result.length===PER_PAGE)
    throw Error("Paginação R2 indeterminada; impedir cópia incompleta.");
   done=true;break;
  }
  if(typeof info.cursor!=="string"||!info.cursor||cursors.has(info.cursor))
   throw Error("Cursor de paginação R2 inválido.");
  cursors.add(info.cursor);cursor=info.cursor;
 }
 if(!done)throw Error("Listagem R2 maior que limite seguro de páginas.");
 return all.sort((a,b)=>a.key.localeCompare(b.key));
}

export async function recoverFullStagingR2({
 token,accountId,runId=process.env.GITHUB_RUN_ID,fetcher=fetch,
 exec=execFileSync,root=resolve(import.meta.dirname,"..")
}){
 if(!/^\d{5,20}$/.test(runId||"")||typeof token!=="string"||token.length<15||
    !/^[0-9a-f]{32}$/i.test(accountId||""))
  throw Error("Identidade/credenciais do ensaio R2 inválidas.");
 const dest="tigu-recovery-full-20261021-"+runId+"-r2";
 await inspectExportTarget({token,accountId,fetcher});
 const source=await listObjects({accountId,token,bucket:SOURCE,fetcher});
 if(!source.length)throw Error("Bucket fonte R2 sem objetos; nenhuma restauração a validar.");
 const base=BASE+accountId+"/r2/buckets";
 const auth={Authorization:"Bearer "+token,Accept:"application/json"};
 const existing=await fetcher(base+"?name_contains="+dest,{method:"GET",redirect:"error",
   headers:auth,signal:AbortSignal.timeout(20000)});
 if(!existing.ok)throw Error("Falha ao conferir se o destino R2 está vazio.");
 const old=await existing.json();
 if(old?.success!==true||!Array.isArray(old.result?.buckets)||
    old.result.buckets.some(x=>x?.name===dest))
  throw Error("Bucket R2 já existe ou inventário inválido: recusar sobrescrita.");
 const created=await fetcher(base,{method:"POST",redirect:"error",
  headers:{...auth,"Content-Type":"application/json"},
  body:JSON.stringify({name:dest}),signal:AbortSignal.timeout(20000)});
 if(!created.ok)throw Error("Criação isolada do bucket R2 negada ("+created.status+").");
 const made=await created.json();
 if(made?.success!==true||made.result?.name!==dest)
  throw Error("Nome de bucket criado não corresponde ao destino isolado.");
 const tmp=mkdtempSync(join(tmpdir(),"tigu-full-r2-"));
 const env={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId};
 let totalBytes=0;
 try{
  for(const [i,item] of source.entries()){
   const local=join(tmp,String(i)+".source");
   const verified=join(tmp,String(i)+".restored");
   function wrangler(op,bucket,file,contentType){
    const path=bucket+"/"+item.key;
    const args=["wrangler","r2","object",op,path,"--remote","--file",file];
    if(op==="put"&&contentType)args.push("--content-type",contentType);
    try{
     exec("npx",args,{cwd:root,env,stdio:"pipe",timeout:180000,maxBuffer:1024*1024});
    }catch{throw Error("Falha Wrangler R2 na cópia/validação do objeto "+(i+1)+" (sem divulgar nome).");}
   }
   wrangler("get",SOURCE,local);
   const bytes=readFileSync(local);
   if(bytes.length!==item.size)throw Error("Fonte R2 alterada durante a leitura.");
   const checksum=sha(bytes);
   wrangler("put",dest,local,item.mime);
   wrangler("get",dest,verified);
   if(sha(readFileSync(verified))!==checksum)
    throw Error("Objeto R2 de recuperação não corresponde ao original (SHA-256).");
   totalBytes+=bytes.length;
  }
  // Revalidar o inventário para detectar uploads concorrentes.
  const srcAfter=await listObjects({accountId,token,bucket:SOURCE,fetcher});
  const dstAfter=await listObjects({accountId,token,bucket:dest,fetcher});
  const fingerprint=items=>JSON.stringify(items.map(x=>[x.key,x.size,x.etag]));
  if(fingerprint(source)!==fingerprint(srcAfter))
   throw Error("Acervo fonte alterado durante recuperação R2; refazer ensaio.");
  if(source.length!==dstAfter.length||
     source.some((v,i)=>v.key!==dstAfter[i]?.key||v.size!==dstAfter[i]?.size))
   throw Error("Inventário completo do bucket restaurado é diferente da fonte.");
  return {
   staging_source:SOURCE,restored_to:dest,objects_verified:source.length,
   bytes_verified:totalBytes,all_source_objects_restored:true,
   sha256_per_object_verified:true,
   object_keys_logged:false,
   content_type_copied_where_declared:true,
   other_http_metadata_verified:false,
   source_unchanged:true,existing_recovery_untouched:true,
   production_modified:false,local_files_removed:true,
  };
 }finally{rmSync(tmp,{recursive:true,force:true});}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.env.GITHUB_ACTIONS!=="true"||
     process.env.GITHUB_EVENT_NAME!=="push"||
     process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
     process.env.TIGU_FULL_R2_RECOVERY_APPROVED!=="YES"||
     process.argv.length!==2)
   throw Error("Recuperação integral R2 requer gatilho único de staging.");
  const report=await recoverFullStagingR2({
   token:process.env.CLOUDFLARE_STAGING_TOKEN,
   accountId:process.env.CLOUDFLARE_ACCOUNT_ID
  });
  console.log("TIGU recuperação integral R2: "+JSON.stringify(report,null,2));
 }catch(e){
  console.error("Falha na recuperação integral R2: "+(e instanceof Error?e.message:String(e)));
  process.exitCode=1;
 }
}
