#!/usr/bin/env node
/**
 * Diagnóstico pontual do erro 500 em /api/auth/register no Worker TIGU STAGING.
 * npx wrangler tail permanece conectado apenas durante 1 POST fictício.
 * Logs NÃO são persistidos e mensagens são REDIGIDAS antes do GitHub Actions.
 */
import {spawn} from "node:child_process";
import {randomBytes} from "node:crypto";
import {pathToFileURL} from "node:url";
import {resolve} from "node:path";

export function sanitizeWorkerError(value){
 const line=String(value??"");
 return line
  .replace(/(?:[\w.+-]+)@(?:[\w.-]+)\.[a-zA-Z]{2,}/g,"[EMAIL]")
  .replace(/\b(?:\+?\d[\d\- ()]{7,}\d)\b/g,"[PHONE]")
  .replace(/(?:Bearer\s+)[^\s"'<>]+/gi,"Bearer [REDACTED]")
  .replace(/\b[a-f0-9]{32,}\b/gi,"[HASH]")
  .replace(/(?:password|token|secret|authorization)\s*[:=]\s*["']?[^,\s}"']+/gi,"[CREDENTIAL]")
  .slice(0,400);
}
export function findSafeTailErrors(chunk){
 const arr=[];
 for(const line of String(chunk).split("\n")){
  if(!line.trim().startsWith("{"))continue;
  let evt;try{evt=JSON.parse(line);}catch{continue;}
  const request=evt?.event?.request || {};
  if(request.method!=="POST"||!String(request.url||"").includes("/api/auth/register"))continue;
  const exc=Array.isArray(evt.exceptions)?evt.exceptions:[];
  const msgs=Array.isArray(evt.logs)?evt.logs:[];
  for(const item of exc){
   if(item?.message)arr.push("exception: "+sanitizeWorkerError(item.message));
  }
  for(const item of msgs){
   const message=Array.isArray(item?.message)?item.message.join(" "):String(item?.message||"");
   if(item?.level==="error"&&message)
     arr.push("console error: "+sanitizeWorkerError(message));
  }
  if(evt?.outcome)arr.push("outcome: "+sanitizeWorkerError(evt.outcome));
 }
 return arr.slice(0,10);
}
export async function collectStagingSignupError({spawnProcess=spawn,request=fetch,sleep=ms=>new Promise(r=>setTimeout(r,ms))}={}){
 if(process.env.GITHUB_ACTIONS!=="true"||process.env.GITHUB_EVENT_NAME!=="push"||
   process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
   process.env.TIGU_DIAGNOSE_APPROVED!=="YES")
   throw Error("Diagnóstico de signup autorizado somente em staging GitHub Actions.");
 const token=process.env.CLOUDFLARE_STAGING_TOKEN;
 const accountId=process.env.CLOUDFLARE_ACCOUNT_ID;
 if(typeof token!=="string"||token.length<15||!/^[a-f0-9]{32}$/i.test(accountId||""))
   throw Error("Credenciais staging ausentes.");
 const env={...process.env,CLOUDFLARE_API_TOKEN:token,CLOUDFLARE_ACCOUNT_ID:accountId,WRANGLER_SEND_METRICS:"false"};
 const tail=spawnProcess("npx",["wrangler","tail","tigu-staging","--format=json","--sampling-rate=1","--method=POST"],{
  env,stdio:["ignore","pipe","pipe"],cwd:process.cwd(),
 });
 const output=[];
 let stderr="";
 function onData(raw){
  const lines=String(raw).split("\n").filter(x=>x.includes('"event"')||x.includes('"exceptions"'));
  for(const item of lines){
   if(output.length<30)output.push(item);
  }
 }
 tail.stdout?.on("data",onData);
 tail.stderr?.on("data",d=>{stderr+=String(d).slice(0,1000);});
 try{
  // Wrangler tail inicia uma sessão de streaming; aguardar conexão.
  await sleep(7500);
  if(tail.exitCode!==null)throw Error("Wrangler tail encerrou sem iniciar; verifique permissão de leitura de logs.");
  const serial=randomBytes(10).toString("hex");
  const response=await request("https://tigu-staging.netssh3-0.workers.dev/api/auth/register",{
   method:"POST",redirect:"manual",signal:AbortSignal.timeout(18000),
   headers:{origin:"https://tigu-staging.netssh3-0.workers.dev","content-type":"application/json"},
   body:JSON.stringify({email:"tigu-diag-"+serial+"@example.test",company_name:"Tigu Diagnostico "+serial.slice(0,6),
    password:"Ficticio!"+randomBytes(24).toString("hex"),name:"Cadastro Ficticio",phone:"",city:""}),
  });
  const status=response.status;
  await sleep(5000);
  const events=findSafeTailErrors(output.join("\n"));
  return {http_status:status,tail_errors:events,
   tail_session_started:tail.exitCode===null,
   tail_messages_seen:output.length,
   safe_stderr_hint:sanitizeWorkerError(stderr.split("\n").filter(x=>/permission|unauthorized|forbidden|error|failed/i.test(x)).slice(-1)[0]||""),
   test_account_fictitious:true,production_modified:false};
 } finally {
  if(tail.exitCode===null)tail.kill("SIGTERM");
 }
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 try{
  if(process.argv.length!==2)throw Error("Argumentos inesperados.");
  const result=await collectStagingSignupError();
  console.log("TIGU staging signup diagnóstico:\n"+JSON.stringify(result,null,2));
  if(result.http_status!==201)process.exitCode=1;
 }catch(e){
  console.error("TIGU signup diagnose: "+sanitizeWorkerError(e?.message||e));
  process.exitCode=1;
 }
}
