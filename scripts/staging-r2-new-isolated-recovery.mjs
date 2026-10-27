#!/usr/bin/env node
/**
 * R2 disaster-recovery drill com objeto binário ALEATÓRIO, jamais dados reais.
 * Origem: tigu-staging-media; destino: tigu-recovery-20261021-<github_run_id> (bucket novo).
 * Faz put -> get origem -> put destino -> get destino e compara SHA-256.
 * Não lista, copia, altera ou remove qualquer objeto de cliente.
 */
import { mkdtempSync,readFileSync,writeFileSync,rmSync } from "node:fs";
import { randomBytes,createHash } from "node:crypto";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { inspectExportTarget } from "./staging-d1-export-verify.mjs";

const runId=process.env.GITHUB_RUN_ID||"";
if(!/^[0-9]{5,20}$/.test(runId))throw Error("Recovery run id inválido.");
const SOURCE="tigu-staging-media",DEST="tigu-recovery-20261021-"+runId+"-r2";
const ACCOUNT=/^[a-f0-9]{32}$/i;
export async function verifyR2RemoteRestore({
  token,accountId,fetcher=fetch,exec=execFileSync,root=resolve(import.meta.dirname,".."),
}) {
  // Confirmar que a conta tem staging Worker, D1 e bucket original ativos.
  await inspectExportTarget({token,accountId,fetcher});
  if(!ACCOUNT.test(accountId||"")||typeof token!=="string"||token.length<15)
    throw Error("Credenciais inválidas.");
  const api="https://api.cloudflare.com/client/v4/accounts/"+accountId+"/r2/buckets";
  const headers={Authorization:"Bearer "+token,Accept:"application/json"};
  async function request(method,url,data){
    if(method==="GET" ? url!==api+"?name_contains="+DEST:
      method!=="POST"||url!==api||data?.name!==DEST||Object.keys(data).length!==1)
      throw Error("Rota R2 fora do escopo restore.");
    const r=await fetcher(url,{method,redirect:"error",signal:AbortSignal.timeout(15000),
      headers:{...headers,...(data?{"Content-Type":"application/json"}:{})},
      ...(data?{body:JSON.stringify(data)}:{})});
    if(!r.ok)throw Error("Cloudflare R2 negou acesso ("+r.status+").");
    const j=await r.json();
    if(j?.success!==true)throw Error("API R2 recusou acesso.");
    return j.result;
  }
  const buckets=await request("GET",api+"?name_contains="+DEST);
  if(!Array.isArray(buckets?.buckets)||buckets.buckets.some(x=>x?.name===DEST))
    throw Error("Bucket de restore já existe ou inventário inválido: não sobrescrever.");
  const created=await request("POST",api,{name:DEST});
  if(created?.name!==DEST)throw Error("Cloudflare não confirmou nome do bucket destino.");
  const tmp=mkdtempSync(join(tmpdir(),"tigu-r2-restore-"));
  try{
    const bytes=randomBytes(1024+Number(randomBytes(1)[0]));
    const key="__tigu_recovery_test/"+randomBytes(12).toString("hex")+".bin";
    const origin=join(tmp,"origin.bin"),download=join(tmp,"download.bin"),copy=join(tmp,"copy.bin");
    writeFileSync(origin,bytes,{mode:0o600});
    const env={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId};
    function wrangler(op,bucket,file){
      const objectPath=bucket+"/"+key;
      const args=["wrangler","r2","object",op,objectPath,"--remote","--file",file];
      try{exec("npx",args,{cwd:root,env,stdio:"pipe",timeout:120000,maxBuffer:1024*1024});}
      catch{throw Error("Wrangler R2 falhou no ensaio de "+op+" para bucket de homologação.");}
    }
    // Objeto novo sob prefixo reservado. Nenhum overwrite de objetos existentes.
    wrangler("put",SOURCE,origin);
    wrangler("get",SOURCE,download);
    if(!readFileSync(download).equals(bytes))throw Error("Cópia do objeto R2 de origem divergiu.");
    wrangler("put",DEST,download);
    wrangler("get",DEST,copy);
    const sha=v=>createHash("sha256").update(v).digest("hex");
    if(sha(bytes)!==sha(readFileSync(copy)))throw Error("Restore R2 divergiu do SHA-256 original.");
    return {source:SOURCE,restored_to:DEST,objects_verified:1,
      bytes_verified:bytes.length,sha256:sha(bytes),
      cloudflare_r2_restore_verified:true,all_bucket_objects_copied:false,
      originals_unchanged:true,production_unchanged:true,local_files_removed:true,
      d1_restore_verified:false};
  } finally {rmSync(tmp,{force:true,recursive:true});}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.env.GITHUB_ACTIONS!=="true"||process.env.GITHUB_EVENT_NAME!=="push"||
       process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
       process.env.TIGU_REMOTE_R2_RESTORE_APPROVED!=="YES"||process.argv.length!==2)
      throw Error("Ensaio R2 exige push staging autorizado.");
    const x=await verifyR2RemoteRestore({
      token:process.env.CLOUDFLARE_STAGING_TOKEN,accountId:process.env.CLOUDFLARE_ACCOUNT_ID,
    });
    console.log("TIGU Disaster Recovery R2: "+JSON.stringify(x,null,2));
  }catch(err){
    console.error("Falha no restore R2 staging: "+(err instanceof Error?err.message:String(err)));
    process.exitCode=1;
  }
}
