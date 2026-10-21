#!/usr/bin/env node
/** Chromium/CDP + React + Worker/D1/R2, todos efêmeros e locais; sem cobranças. */
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes } from "node:crypto";
assert.equal(process.argv.length,2,"Teste não recebe URLs, flags ou destinos remotos");
const root=resolve(import.meta.dirname,".."),tmp=mkdtempSync(join(tmpdir(),"tigu-browser-"));
const config=join(tmp,"wrangler.json"),state=join(tmp,"state"),cli=join(root,"node_modules/wrangler/bin/wrangler.js");
const env={...process.env,CI:"true",WRANGLER_SEND_METRICS:"false",CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:"false"};
const secret=()=>randomBytes(32).toString("hex");
writeFileSync(config,JSON.stringify({
  name:"tigu-chromium-smoke",main:join(root,"api/index.ts"),compatibility_date:"2025-01-01",
  compatibility_flags:["nodejs_compat"],
  vars:{APP_ENV:"development",TIGU_STAGING:"1",WHATSAPP_MOCK:"1",PAYMENTS_MOCK:"0",
    GRAPH_API_VERSION:"v23.0",SESSION_SECRET:secret(),MSG_ENC_KEY:secret()},
  assets:{directory:join(root,"dist"),binding:"ASSETS",not_found_handling:"single-page-application",
    run_worker_first:["/api/*","/uploads/*"]},
  d1_databases:[{binding:"DB",database_name:"tigu-chromium-smoke-db",
    database_id:"00000000-0000-4000-8000-000000000099",migrations_dir:join(root,"migrations")}],
  r2_buckets:[{binding:"MEDIA",bucket_name:"tigu-chromium-media"}]
}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function wrangler(args){return execFileSync(process.execPath,[cli,...args,"--local","--config",config,"--persist-to",state],
  {cwd:root,env,encoding:"utf8",timeout:120000,maxBuffer:8*1024*1024});}
function port(){return new Promise((ok,bad)=>{const srv=createServer();srv.on("error",bad);
  srv.listen(0,"127.0.0.1",()=>{const p=srv.address().port;srv.close(()=>ok(p));});});}
async function ready(url,isDead,limit=45000){const deadline=Date.now()+limit;
  while(Date.now()<deadline){if(isDead())throw Error("Processo local foi encerrado");
    try{if((await fetch(url,{signal:AbortSignal.timeout(800)})).ok)return;}catch{}
    await pause(250);
  }throw Error("Serviço local não iniciou: "+url);}
let worker,chrome,ws;let seq=0;const pending=new Map();
function cmd(method,params={}){const id=++seq;return new Promise((ok,bad)=>{
  const t=setTimeout(()=>{pending.delete(id);bad(Error("CDP timeout: "+method));},15000);
  pending.set(id,{ok,bad,t});ws.send(JSON.stringify({id,method,params}));
});}
async function js(code){const res=await cmd("Runtime.evaluate",{expression:code,returnByValue:true,awaitPromise:true});
  if(res.exceptionDetails)throw Error(res.exceptionDetails.text||"Erro JS no Chromium");
  return res.result?.value;}
async function until(label,condition,max=18000){const deadline=Date.now()+max;
  while(Date.now()<deadline){if(await js(condition))return;await pause(180);}
  throw Error("Não apareceu: "+label+". Página: "+await js("location.pathname+' '+document.body.innerText.slice(0,200)"));}
async function go(url){const nav=await cmd("Page.navigate",{url});if(nav.errorText)throw Error(nav.errorText);
  await until("documento",'document.readyState==="complete"');}
async function click(text){const found=await js('(()=>{const b=[...document.querySelectorAll("button")]'+
  '.find(x=>x.textContent.includes('+JSON.stringify(text)+')&&!x.disabled);if(!b)return false;b.click();return true})()');
  assert.ok(found,"Botão não encontrado ou desabilitado: "+text);}
async function fill(selector,value){const found=await js('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');'+
  'if(!e)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,'+
  JSON.stringify(value)+');e.dispatchEvent(new Event("input",{bubbles:true}));'+
  'e.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  assert.ok(found,"Campo não encontrado: "+selector);}
function pass(name,success=true){assert.ok(success,name);console.log("✔ Chromium: "+name);}
async function api(base,path,method="GET",body,cookie=""){const res=await fetch(base+path,{method,
  headers:{...(body?{"content-type":"application/json"}:{}),...(cookie?{cookie}:{})},
  ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  return {status:res.status,data:await res.json().catch(()=>null),
    cookie:res.headers.get("set-cookie")?.split(";")[0]||""};}
try{
  const executable=["google-chrome","google-chrome-stable","chromium","chromium-browser"].find(name=>{
    try{execFileSync("which",[name],{stdio:"ignore"});return true;}catch{return false;}});
  assert.ok(executable,"Google Chrome/Chromium não instalado no runner");
  wrangler(["d1","migrations","apply","tigu-chromium-smoke-db"]);
  const webPort=await port(),chromePort=await port(),base="http://127.0.0.1:"+webPort;
  worker=spawn(process.execPath,[cli,"dev","--local","--config",config,"--persist-to",state,
    "--ip","127.0.0.1","--port",String(webPort),"--inspector-port","0"],
    {cwd:root,env,stdio:"ignore"});
  await ready(base+"/api/health",()=>worker.exitCode!==null);
  const email="browser-"+randomBytes(5).toString("hex")+"@tigu.test";
  const password="Browser!"+randomBytes(14).toString("hex");
  const signup=await api(base,"/api/auth/register","POST",{company_name:"Barbearia Chromium Local",
    name:"Dono Browser",email,password});
  assert.equal(signup.status,201,"Cadastro de empresa local");
  const slug=signup.data.company.slug;
  const product=await api(base,"/api/c/"+slug+"/admin/products","POST",
    {name:"Pomada Navegador",description:"Produto seguro",price_cents:3490,stock:4,
      category:"cuidados",photo:"",active:true},signup.cookie);
  assert.equal(product.status,200,"Cadastro de produto no D1");
  chrome=spawn(executable,["--headless=new","--no-sandbox","--disable-dev-shm-usage",
    "--disable-background-networking","--no-first-run","--no-default-browser-check",
    "--disable-extensions","--window-size=1280,960",
    "--remote-debugging-address=127.0.0.1","--remote-debugging-port="+chromePort,
    "--remote-allow-origins=*","--user-data-dir="+join(tmp,"chrome"),"about:blank"],
    {cwd:root,stdio:"ignore"});
  let target;const deadline=Date.now()+25000;
  while(Date.now()<deadline){if(chrome.exitCode!==null)throw Error("Chromium encerrou");
    try{const list=await (await fetch("http://127.0.0.1:"+chromePort+"/json/list",
      {signal:AbortSignal.timeout(1000)})).json();
      target=list.find(x=>x.type==="page"&&x.webSocketDebuggerUrl);if(target)break;}catch{}
    await pause(200);}
  assert.ok(target,"Depuração Chromium CDP não iniciou");
  ws=new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((ok,bad)=>{ws.addEventListener("open",ok,{once:true});
    ws.addEventListener("error",bad,{once:true});});
  ws.addEventListener("message",evt=>{const obj=JSON.parse(evt.data);
    if(obj.id&&pending.has(obj.id)){const p=pending.get(obj.id);
      clearTimeout(p.t);pending.delete(obj.id);
      if(obj.error)p.bad(Error(obj.error.message));else p.ok(obj.result);}});
  await cmd("Page.enable");await cmd("Runtime.enable");
  await cmd("Page.addScriptToEvaluateOnNewDocument",{source:"window.open=function(){return null;};"});
  await go(base+"/c/"+slug);
  await until("produto na vitrine",'document.body.innerText.includes("Pomada Navegador")');
  pass("vitrine carrega produto real do D1");
  await click("Adicionar ao carrinho");
  await click("Ver carrinho");
  await until("carrinho React",'document.body.innerText.includes("Finalizar pedido pelo WhatsApp")');
  pass("carrinho reage ao clique");
  await click("Finalizar pedido pelo WhatsApp");
  await until("formulário do checkout",'document.querySelector("input[placeholder*=\\"João\\"]")!==null');
  await fill('input[placeholder*="João"]',"Cliente Navegador");
  await fill('input[placeholder*="99999-0000"]',"73999990000");
  await click("Confirmar e enviar no WhatsApp");
  await until("pedido registrado",'document.body.innerText.includes("Pedido registrado:")');
  pass("checkout registra pedido sem cobrar automaticamente");
  await go(base+"/login?next="+encodeURIComponent("/c/"+slug+"/admin/dashboard"));
  await until("form login",'document.querySelector("input[type=email]")!==null');
  await fill("input[type=email]",email);await fill("input[type=password]",password);
  await click("Entrar");
  await until("dashboard autenticado",'location.pathname.endsWith("/admin/dashboard")&&document.body.innerText.includes("Visão geral")');
  pass("autenticação e dashboard do dono");
  await go(base+"/c/"+slug+"/admin/pedidos");
  await until("pedido no painel",'document.body.innerText.includes("Cliente Navegador")');
  pass("venda aparece no painel administrativo");
  await go(base+"/c/"+slug+"/admin/produtos");
  await until("produto no painel",'document.body.innerText.includes("Pomada Navegador")');
  pass("estoque aparece no painel");
  await go(base+"/c/"+slug+"/admin/carteira");
  await until("carteira",'document.body.innerText.includes("Carteira de créditos")');
  pass("Pix real bloqueado no ambiente local",await js('(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.includes("via Pix"));return !!b&&b.disabled})()'));
  console.log("7 verificações Chromium aprovadas: React, Worker e D1 locais; nenhum pagamento real.");
}finally{
  if(ws)ws.close();
  for(const child of [chrome,worker])if(child&&child.exitCode===null){
    child.kill("SIGTERM");
    await Promise.race([new Promise(r=>child.once("exit",r)),pause(1500)]);
    if(child.exitCode===null)child.kill("SIGKILL");
  }
  rmSync(tmp,{recursive:true,force:true});
}
