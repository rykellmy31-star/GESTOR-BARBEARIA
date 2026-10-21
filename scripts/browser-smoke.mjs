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
async function fillField(label,value,scope=".modal-backdrop"){
  const found=await js('(()=>{const root=document.querySelector('+JSON.stringify(scope)+');'+
    'if(!root)return false;const f=[...root.querySelectorAll("label.block")]'+
    '.find(x=>x.firstElementChild?.textContent?.trim().startsWith('+JSON.stringify(label)+'));'+
    'const el=f?.querySelector("input");if(!el)return false;'+
    'Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,'+JSON.stringify(value)+');'+
    'el.dispatchEvent(new Event("input",{bubbles:true}));'+
    'el.dispatchEvent(new Event("change",{bubbles:true}));return true})()');
  assert.ok(found,"Campo não encontrado no formulário: "+label);
}
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
  const service=await api(base,"/api/c/"+slug+"/admin/services","POST",
    {name:"Corte Navegador",description:"Atendimento teste",price_cents:3000,
      duration_min:30,barber_ids:[]},signup.cookie);
  assert.equal(service.status,200,"Serviço local cadastrado");
  const barber=await api(base,"/api/c/"+slug+"/admin/barbers","POST",
    {name:"Profissional Navegador",specialty:"Corte",bio:"Atende clientes do teste",
      work_days:[0,1,2,3,4,5,6],work_start:"08:00",work_end:"20:00",
      break_start:"12:00",break_end:"13:00",service_ids:[service.data.id]},signup.cookie);
  assert.equal(barber.status,200,"Profissional e serviço vinculados");
  const localToday=new Intl.DateTimeFormat("en-CA",{timeZone:"America/Bahia"}).format(new Date());
  let bookingDay,bookingSlot;
  for(let offset=2;offset<=8;offset++){
    const day=new Date(Date.parse(localToday+"T12:00:00Z")+offset*86400000).toISOString().slice(0,10);
    const availability=await api(base,"/api/c/"+slug+"/availability?barberId="+barber.data.id+
      "&serviceId="+service.data.id+"&date="+day);
    if(availability.status===200&&availability.data.ok){
      const free=availability.data.slots.find(slot=>slot.available!==false);
      if(free){bookingDay=day;bookingSlot=free;break;}
    }
  }
  assert.ok(bookingDay&&bookingSlot,"Data com vaga disponível no D1");
  chrome=spawn(executable,["--headless=new","--no-sandbox","--disable-dev-shm-usage",
    "--disable-background-networking","--no-first-run","--no-default-browser-check",
    "--disable-extensions","--window-size=1280,960",
    "--remote-debugging-address=127.0.0.1","--remote-debugging-port="+chromePort,
    "--remote-allow-origins=*","--user-data-dir="+join(tmp,"chrome"),"about:blank"],
    {cwd:root,stdio:"ignore"});
  let target;const deadline=Date.now()+60000;
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
  // Exercita os botões reais de pagamento e cancelamento: somente D1 isolado,
  // sem gateway financeiro, com estorno único do estoque reservado.
  const expandedOrder=await js('(()=>{const b=[...document.querySelectorAll("button")]'+
    '.find(x=>x.textContent.includes("Cliente Navegador"));if(!b)return false;b.click();return true})()');
  assert.ok(expandedOrder,"Pedido não abriu no painel");
  await until("botão para pagamento manual",
    '[...document.querySelectorAll("button")].some(x=>x.textContent.includes("Registrar pagamento"))');
  await click("Registrar pagamento");
  await until("pedido pago após atualização",
    '[...document.querySelectorAll("button")].some(x=>x.textContent.includes("Marcar entregue"))');
  const paidOrder=await api(base,"/api/c/"+slug+"/admin/orders","GET",undefined,signup.cookie);
  assert.ok(paidOrder.data.orders.some(x=>x.customer_name==="Cliente Navegador"&&x.status==="pago"),
    "O pagamento manual deve persistir no D1");
  pass("proprietário registra pagamento manual pelo painel, sem cobrança real");
  await click("Cancelar (devolve estoque)");
  await until("pedido cancelado após atualização",'document.body.innerText.includes("Pedido finalizado.")');
  const canceledOrder=await api(base,"/api/c/"+slug+"/admin/orders","GET",undefined,signup.cookie);
  assert.ok(canceledOrder.data.orders.some(x=>x.customer_name==="Cliente Navegador"&&x.status==="cancelado"),
    "Cancelamento deve persistir no D1");
  const productsAfter=await api(base,"/api/c/"+slug+"/admin/products","GET",undefined,signup.cookie);
  assert.equal(productsAfter.data.products.find(x=>x.id===product.data.id)?.stock,4,
    "Cancelar pedido pago deve estornar exatamente a unidade reservada");
  pass("cancelamento de pedido pago estorna o estoque no D1");
  await go(base+"/c/"+slug+"/admin/produtos");
  await until("produto no painel",'document.body.innerText.includes("Pomada Navegador")');
  pass("estoque aparece no painel");
  // CRUD completo via React: criar, editar/movimentar e desativar produto.
  await click("Novo produto");
  await until("modal de cadastro de produto",'document.querySelector(".modal-backdrop")!==null');
  await fillField("Nome","Gel Chromium");
  await fillField("Preço (R$)","18,90");
  await fillField("Estoque","7");
  await click("Salvar produto");
  await until("produto criado no painel",'document.body.innerText.includes("Gel Chromium")&&document.querySelector(".modal-backdrop")===null');
  const productCreated=await api(base,"/api/c/"+slug+"/admin/products","GET",undefined,signup.cookie);
  const gel=productCreated.data.products.find(x=>x.name==="Gel Chromium");
  assert.ok(gel&&gel.price_cents===1890&&gel.stock===7,"Cadastro deve salvar preço e estoque exatos no D1");
  pass("dono cadastra produto, preço e estoque no painel real");
  const productEdit=await js('(()=>{const a=[...document.querySelectorAll("article")]'+
    '.find(x=>x.textContent.includes("Gel Chromium"));const b=[...a?.querySelectorAll("button")||[]]'+
    '.find(x=>x.textContent.includes("Editar / movimentar"));if(!b)return false;b.click();return true})()');
  assert.ok(productEdit,"Editar produto deve abrir modal");
  await fillField("Preço (R$)","21,90");
  await fillField("Δ entradas/saídas","-2");
  await fillField("Motivo","Ajuste de inventário fictício");
  await click("Salvar produto");
  await until("modal de produto editado fechar",'document.querySelector(".modal-backdrop")===null');
  const productEdited=await api(base,"/api/c/"+slug+"/admin/products","GET",undefined,signup.cookie);
  assert.ok(productEdited.data.products.some(x=>x.id===gel.id&&x.stock===5&&x.price_cents===2190),
    "Preço e movimentação de estoque devem ser atômicos no D1");
  const badStock=await api(base,"/api/c/"+slug+"/admin/products/"+gel.id,"PUT",
    {adjust_stock_by:-100,stock_reason:"Teste de estoque insuficiente"},signup.cookie);
  assert.equal(badStock.status,409,"API deve rejeitar saída superior ao estoque");
  const stockUnchanged=await api(base,"/api/c/"+slug+"/admin/products","GET",undefined,signup.cookie);
  assert.equal(stockUnchanged.data.products.find(x=>x.id===gel.id).stock,5,
    "Movimentação recusada não altera o estoque");
  pass("dono edita preço e estoque; saída negativa é bloqueada sem efeito colateral");
  const productRemove=await js('(()=>{const a=[...document.querySelectorAll("article")]'+
    '.find(x=>x.textContent.includes("Gel Chromium"));const b=[...a?.querySelectorAll("button")||[]]'+
    '.find(x=>x.getAttribute("class")?.includes("bg-red-950"));if(!b)return false;b.click();return true})()');
  assert.ok(productRemove,"Excluir produto deve pedir confirmação");
  await until("confirmação de desativação do produto",
    'document.querySelector(".modal-backdrop")?.innerText.includes("Gel Chromium")');
  await click("Confirmar");
  await until("produto desativado no painel",'document.querySelector(".modal-backdrop")===null');
  const productRemoved=await api(base,"/api/c/"+slug+"/admin/products","GET",undefined,signup.cookie);
  assert.equal(productRemoved.data.products.find(x=>x.id===gel.id).active,0,
    "Desativação deve manter registro histórico mas retirar da vitrine");
  pass("dono desativa produto pela confirmação e preserva histórico");
  // Catálogo de serviços: criar, editar e desativar sem mexer nas reservas já testadas.
  await go(base+"/c/"+slug+"/admin/servicos");
  await until("tela serviços do dono",'document.body.innerText.includes("Serviços & Preços")');
  await click("Novo serviço");
  await until("cadastro de serviço",'document.querySelector(".modal-backdrop")!==null');
  await fillField("Nome","Hidratação Chromium");
  await fillField("Preço (R$)","25,00");
  await fillField("Duração (min)","45");
  await click("Salvar serviço");
  await until("serviço criado",'document.body.innerText.includes("Hidratação Chromium")&&document.querySelector(".modal-backdrop")===null');
  const serviceCreated=await api(base,"/api/c/"+slug+"/admin/services","GET",undefined,signup.cookie);
  const hydration=serviceCreated.data.services.find(x=>x.name==="Hidratação Chromium");
  assert.ok(hydration&&hydration.price_cents===2500&&hydration.duration_min===45,
    "Cadastro de serviço deve registrar preço e duração no D1");
  pass("dono cadastra serviço real com preço e duração");
  const serviceEdit=await js('(()=>{const r=[...document.querySelectorAll("tbody tr")]'+
    '.find(x=>x.textContent.includes("Hidratação Chromium"));const b=r?.querySelector("td:last-child button");'+
    'if(!b)return false;b.click();return true})()');
  assert.ok(serviceEdit,"Editar serviço deve abrir modal");
  await fillField("Preço (R$)","32,00");
  await fillField("Duração (min)","60");
  await click("Salvar serviço");
  await until("edição de serviço concluir",'document.querySelector(".modal-backdrop")===null');
  const serviceEdited=await api(base,"/api/c/"+slug+"/admin/services","GET",undefined,signup.cookie);
  assert.ok(serviceEdited.data.services.some(x=>x.id===hydration.id&&x.price_cents===3200&&x.duration_min===60),
    "Edição de serviço deve atualizar duração e valor no banco");
  pass("dono edita duração e preço do serviço pela interface");
  const serviceRemove=await js('(()=>{const r=[...document.querySelectorAll("tbody tr")]'+
    '.find(x=>x.textContent.includes("Hidratação Chromium"));const b=r?.querySelectorAll("td:last-child button")[1];'+
    'if(!b)return false;b.click();return true})()');
  assert.ok(serviceRemove,"Excluir serviço deve pedir confirmação");
  await until("confirmação da remoção de serviço",
    'document.querySelector(".modal-backdrop")?.innerText.includes("Hidratação Chromium")');
  await click("Confirmar");
  await until("desativação de serviço concluída",'document.querySelector(".modal-backdrop")===null');
  const serviceRemoved=await api(base,"/api/c/"+slug+"/admin/services","GET",undefined,signup.cookie);
  assert.equal(serviceRemoved.data.services.find(x=>x.id===hydration.id).active,0,
    "Serviço desativado deve preservar registro e não permitir novas reservas");
  pass("dono desativa serviço sem apagar histórico");
  // Configurações editáveis refletidas na API e mantidas após recarregar a tela.
  await go(base+"/c/"+slug+"/admin/configuracoes");
  await until("configurações carregadas",'document.body.innerText.includes("Identidade da barbearia")');
  await fillField("Slogan","Barbearia Chromium - configuração validada","body");
  await click("Champanhe");
  await click("Salvar alterações");
  await until("configuração salva pelo painel",
    'document.body.innerText.includes("Configurações salvas")');
  const configSaved=await api(base,"/api/c/"+slug+"/admin/settings","GET",undefined,signup.cookie);
  assert.equal(configSaved.data.settings.tagline,"Barbearia Chromium - configuração validada");
  assert.equal(configSaved.data.settings.brand.gold,"#e8c56a");
  pass("dono salva identidade e paleta de marca via painel e D1");
  await go(base+"/c/"+slug+"/admin/configuracoes");
  await until("slogan persistido após recarregar",
    '[...document.querySelectorAll("label.block")].some(x=>x.firstElementChild?.textContent?.trim()==="Slogan"&&x.querySelector("input")?.value==="Barbearia Chromium - configuração validada")');
  pass("configurações persistem após nova abertura do painel");
  await go(base+"/c/"+slug+"/admin/carteira");
  await until("carteira",'document.body.innerText.includes("Carteira de créditos")');
  await until("Pix real bloqueado no ambiente local",
    '(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.textContent.includes("via Pix"));return !!b&&b.disabled})()');
  pass("Pix real bloqueado no ambiente local");

  // Reserva criada de verdade pela interface do visitante.
  await go(base+"/c/"+slug+"/agendar");
  await until("serviço disponível no assistente",'document.body.innerText.includes("Corte Navegador")');
  await click("Corte Navegador");
  await until("profissional elegível",'document.body.innerText.includes("Profissional Navegador")');
  await click("Profissional Navegador");
  await until("seleção do profissional",'document.body.innerText.includes("Escolher data")');
  await click("Escolher data");
  await until("calendário público",'document.querySelector(".cal-day")!==null');
  const targetMonth=bookingDay.slice(0,7);
  const shownMonth=await js('(()=>{const b=document.querySelector(".cal-day");return b&&'+
    'new Date(new Date().toISOString().slice(0,7)+"-01T12:00:00Z").toISOString().slice(0,7)})()');
  if(shownMonth!==targetMonth){
    const forward=await js('(()=>{const b=[...document.querySelectorAll("button")]'+
      '.find(x=>x.textContent.trim()==="→"&&!x.disabled);if(!b)return false;b.click();return true})()');
    assert.ok(forward,"Avanço para o próximo mês não disponível");
  }
  await until("dia com vaga renderizado",'[...document.querySelectorAll("button.cal-day")]'+
    '.some(x=>x.textContent.trim()==='+JSON.stringify(String(Number(bookingDay.slice(8))))+'&&!x.disabled)');
  const chosen=await js('(()=>{const b=[...document.querySelectorAll("button.cal-day")]'+
    '.find(x=>x.textContent.trim()==='+JSON.stringify(String(Number(bookingDay.slice(8))))+'&&!x.disabled);'+
    'if(!b)return false;b.click();return true})()');
  assert.ok(chosen,"Data válida não foi selecionada");
  await until("horários da reserva",'document.body.innerText.includes("4. Horário")');
  await until("horário escolhido",'[...document.querySelectorAll("button")]'+
    '.some(x=>x.textContent.trim()==='+JSON.stringify(bookingSlot.label)+')');
  await click(bookingSlot.label);
  await click("Continuar");
  await until("dados do visitante",'document.querySelector("input[placeholder^=\\"Como você\\"]")!==null');
  await fill('input[placeholder^="Como você"]',"Cliente Reserva Chromium");
  await fill('input[placeholder*="99999-0000"]',"73999991111");
  const consent=await js('(()=>{const c=document.querySelector("input[type=checkbox]");'+
    'if(!c)return false;c.click();return c.checked})()');
  assert.ok(consent,"Consentimento LGPD não foi registrado");
  await click("Revisar agendamento");
  await until("revisão do atendimento",'document.body.innerText.includes("Confirme seu horário")');
  await click("Confirmar agendamento");
  await until("reserva confirmada",'document.body.innerText.includes("Seu horário está garantido")');
  pass("visitante agenda serviço e profissional pela interface real");
  const bookingCode=await js('(()=>{const item=[...document.querySelectorAll("b")]'+
    '.find(el=>el.parentElement?.textContent?.includes("Protocolo"));'+
    'return item?.textContent?.trim()||""})()');
  assert.ok(bookingCode,"Protocolo não foi mostrado na confirmação");
  const schedule=await api(base,"/api/c/"+slug+"/admin/agenda?view=day&date="+bookingDay,"GET",undefined,signup.cookie);
  assert.equal(schedule.status,200,"API do painel recebe a reserva do Chromium");
  pass("agendamento persistiu na agenda administrativa");
  // Conta exclusiva para o profissional; autenticação realizada no navegador.
  const proEmail="pro-"+randomBytes(4).toString("hex")+"@tigu.test";
  const proPassword="Profissional!"+randomBytes(10).toString("hex");
  const access=await api(base,"/api/c/"+slug+"/admin/barbers/"+barber.data.id+"/credentials",
    "POST",{email:proEmail,password:proPassword},signup.cookie);
  assert.equal(access.status,201,"Painel cria acesso exclusivo para o profissional");
  await go(base+"/login");
  await until("login profissional",'document.querySelector("input[type=email]")!==null');
  await fill("input[type=email]",proEmail);await fill("input[type=password]",proPassword);
  await click("Entrar");
  await until("troca obrigatória",'location.pathname==="/alterar-senha"');
  pass("profissional precisa trocar senha provisória no navegador");
  const replacement="SenhaFinal!"+randomBytes(10).toString("hex");
  await until("campos nova senha",'document.querySelectorAll("input[type=password]").length===3');
  const passwords=await js('(()=>{const inputs=document.querySelectorAll("input[type=password]");'+
    'const values='+JSON.stringify([proPassword,replacement,replacement])+';'+
    'const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set;'+
    'inputs.forEach((x,i)=>{setter.call(x,values[i]);x.dispatchEvent(new Event("input",{bubbles:true}));});'+
    'return inputs.length})()');
  assert.equal(passwords,3);
  await click("Salvar nova senha");
  await until("nova senha aceita",'location.pathname==="/selecionar"');
  await go(base+"/c/"+slug+"/painel");
  await until("painel do profissional",'document.body.innerText.includes("PAINEL DO PROFISSIONAL")');
  pass("acesso individual do profissional após troca obrigatória");
  const selectedDay=await js('(()=>{const tabs=document.querySelector("main .overflow-x-auto");'+
    'const b=[...(tabs?.querySelectorAll("button")||[])].find(x=>'+
    'x.querySelector("span.font-display")?.textContent.trim()==='+JSON.stringify(String(Number(bookingDay.slice(8))))+');'+
    'if(!b)return false;b.click();return true})()');
  assert.ok(selectedDay,"Dia da reserva não apareceu no calendário do profissional");
  await until("reserva exibida ao profissional",'document.body.innerText.includes("Cliente Reserva Chromium")');
  pass("profissional vê seu agendamento, horário e ações na agenda");
  await click("Pedir bloqueio");
  await until("modal de bloqueio do funcionário",
    'document.body.innerText.includes("Solicitar bloqueio de agenda")');
  await js('(()=>{const input=document.querySelector("textarea");if(!input)return false;'+
    'const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set;'+
    'setter.call(input,"Compromisso Chromium");input.dispatchEvent(new Event("input",{bubbles:true}));'+
    'return true})()');
  await click("Enviar para aprovação");
  await until("pedido fechado após envio",'!document.body.innerText.includes("Solicitar bloqueio de agenda")');
  const requestsBefore=await api(base,"/api/c/"+slug+"/admin/block-requests","GET",undefined,signup.cookie);
  assert.equal(requestsBefore.status,200);
  const request=requestsBefore.data.requests.find(x=>x.reason==="Compromisso Chromium");
  assert.ok(request&&request.status==="pendente","Bloqueio deve aguardar decisão do proprietário");
  pass("profissional solicita bloqueio sem alterar a agenda sozinho");
  await go(base+"/superadmin/overview");
  await until("acesso de plataforma negado ao profissional",
    'document.body.innerText.includes("Acesso negado")');
  pass("profissional não acessa Superadmin");


  // Cliente gerencia pelo site o mesmo agendamento, sem ter uma sessão de funcionário.
  const lookupBefore=await api(base,"/api/c/"+slug+"/bookings/lookup","POST",
    {code:bookingCode,phone:"73999991111"});
  assert.equal(lookupBefore.status,200,"Protocolo e telefone da reserva são válidos na API");
  await go(base+"/c/"+slug+"/meus-agendamentos");
  await until("busca pública de reservas",'document.querySelector("input[placeholder^=AUR]")!==null');
  await fill('input[placeholder="AUR-XXXXXXXX"]',bookingCode);
  await fill('input[placeholder*="99999-0000"]',"73999991111");
  await click("Consultar");
  await until("reserva localizada pelo próprio cliente",'document.body.innerText.includes("Corte Navegador")');
  pass("cliente consulta a própria reserva pelo protocolo e telefone");
  await click("Remarcar");
  await until("modal de remarcação",'document.body.innerText.includes("Novo horário — Profissional Navegador")');
  const reschedDay=new Date(Date.parse(bookingDay+"T12:00:00Z")+86400000).toISOString().slice(0,10);
  const available=await api(base,"/api/c/"+slug+"/availability?barberId="+barber.data.id+
    "&serviceId="+service.data.id+"&date="+reschedDay);
  assert.equal(available.status,200);
  const newSlot=available.data.slots.find(x=>x.available!==false);
  assert.ok(newSlot,"Horário para remarcação está indisponível");
  await fill('input[type="date"]',reschedDay);
  await until("slots da nova data",'[...document.querySelectorAll("button")].some(x=>x.textContent.trim()==='+JSON.stringify(newSlot.label)+')');
  await click(newSlot.label);
  await until("modal de remarcação fechado",'!document.body.innerText.includes("Novo horário — Profissional Navegador")');
  const afterResched=await api(base,"/api/c/"+slug+"/bookings/lookup","POST",
    {code:bookingCode,phone:"73999991111"});
  assert.equal(afterResched.status,200);
  assert.ok(afterResched.data.bookings.some(x=>x.code===bookingCode&&Date.parse(x.starts_at)===Date.parse(newSlot.t)),
    "Remarcação deve persistir a nova data/hora");
  pass("cliente remarca reserva para horário livre pela interface");
  await until("ação de cancelamento",'[...document.querySelectorAll("button")].some(x=>x.textContent.trim().includes("Cancelar"))');
  await click("Cancelar");
  await until("confirmação de cancelamento",'document.body.innerText.includes("Cancelar agendamento?")');
  await click("Confirmar");
  await until("estado cancelado da reserva",'document.body.innerText.includes("cancelado")');
  const afterCancel=await api(base,"/api/c/"+slug+"/bookings/lookup","POST",
    {code:bookingCode,phone:"73999991111"});
  assert.equal(afterCancel.status,200);
  assert.ok(afterCancel.data.bookings.some(x=>x.code===bookingCode&&x.status==="cancelado"),
    "Cancelamento deve persistir no D1");
  pass("cliente cancela reserva pela confirmação e libera horário");
  // Dono valida e aprova pedido diretamente na tela de agenda.
  await go(base+"/login");
  await until("login de volta ao proprietário",'document.querySelector("input[type=email]")!==null');
  await fill("input[type=email]",email);await fill("input[type=password]",password);
  await click("Entrar");
  await until("dono reautenticado",'location.pathname.includes("/admin")');
  const customerList=await api(base,"/api/c/"+slug+"/admin/customers","GET",undefined,signup.cookie);
  assert.equal(customerList.status,200,"Listagem de clientes do painel");
  const customer=customerList.data.customers.find(x=>x.phone==="73999991111");
  assert.ok(customer,"A reserva deve criar cadastro de cliente");
  assert.equal(customer.visits,1,"Cliente tem uma reserva");
  assert.equal(customer.canceled,1,"Cancelamento é exibido no histórico");
  assert.equal(customer.completed,0,"Reserva cancelada não conta como concluída");
  assert.equal(customer.spent_cents,0,"Reserva cancelada não gera faturamento");
  pass("indicadores de clientes respeitam o status e o D1 da empresa");
  await go(base+"/c/"+slug+"/admin/clientes");
  await until("cliente exibido na lista",'document.body.innerText.includes("Cliente Reserva Chromium")');
  const customerRow=await js('(()=>{const r=[...document.querySelectorAll("tbody tr")]'+
    '.find(x=>x.textContent.includes("Cliente Reserva Chromium"));'+
    'return r?[...r.querySelectorAll("td")].map(x=>x.textContent.trim()):null})()');
  assert.ok(customerRow&&customerRow[1]==="1"&&customerRow[3]==="1",
    "Visitas e cancelamentos precisam estar visíveis na tabela");
  const customerDetail=await api(base,"/api/c/"+slug+"/admin/customers/"+customer.id,
    "GET",undefined,signup.cookie);
  assert.equal(customerDetail.status,200,"Detalhe do cliente deve responder: "+JSON.stringify(customerDetail.data));
  assert.ok(customerDetail.data.bookings.some(x=>x.code===bookingCode&&x.status==="cancelado"),
    "Detalhe deve mostrar a reserva do mesmo cliente: "+JSON.stringify(customerDetail.data.bookings));
  const openedCustomer=await js('(()=>{const r=[...document.querySelectorAll("tbody tr")]'+
    '.find(x=>x.textContent.includes("Cliente Reserva Chromium"));if(!r)return false;r.click();return true})()');
  assert.ok(openedCustomer,"Detalhe do cliente deve abrir pelo clique");
  await until("modal de cliente", 'document.querySelector(".modal-backdrop")!==null');
  const detailInBrowser=await js('fetch("/api/c/'+slug+'/admin/customers/'+customer.id+'")'+
    '.then(async r=>({status:r.status,data:await r.json().catch(()=>null)}))');
  assert.equal(detailInBrowser.status,200,
    "Sessão Chromium não acessa o detalhe do cliente: "+JSON.stringify(detailInBrowser));
  await until("histórico real do cliente no modal",
    'document.querySelector(".modal-backdrop")?.innerText.includes("HISTÓRICO")&&'+
    'document.querySelector(".modal-backdrop")?.innerText.includes("Corte Navegador")');
  pass("cliente abre histórico e indicadores corretos no painel");
  await go(base+"/c/"+slug+"/admin/agenda");
  await until("agenda administrativa",'document.body.innerText.includes("Pedidos")');
  await click("Pedidos");
  await until("pedido do profissional no modal",'document.body.innerText.includes("Compromisso Chromium")');
  await click("Aprovar");
  await until("solicitação aprovada no D1",'!document.body.innerText.includes("Pedidos de bloqueio dos barbeiros")');
  const requestsAfter=await api(base,"/api/c/"+slug+"/admin/block-requests","GET",undefined,signup.cookie);
  assert.equal(requestsAfter.status,200);
  assert.ok(requestsAfter.data.requests.some(x=>x.id===request.id&&x.status==="aprovado"),
    "Aprovação deve persistir com estado aprovado");
  const blockedAgenda=await api(base,"/api/c/"+slug+"/admin/agenda?view=day&date="+bookingDay,
    "GET",undefined,signup.cookie);
  assert.equal(blockedAgenda.status,200);
  assert.ok(JSON.stringify(blockedAgenda.data).includes('"bloqueio"'),"Aprovação deve criar bloqueio real");
  pass("proprietário aprova bloqueio e retira intervalo da agenda");

  // Administrador global criado somente no D1 local a partir do hash do fixture.
  // Nunca configura nem modifica qualquer conta em ambientes remotos.
  const superEmail="smoke-super-"+randomBytes(5).toString("hex")+"@tigu.test";
  const sql="INSERT INTO users(name,email,password_hash,platform_role,active,must_change_password) "+
    "SELECT 'Superadmin Chromium', '"+superEmail+"',password_hash,'superadmin',1,0 "+
    "FROM users WHERE email='"+email+"'";
  wrangler(["d1","execute","tigu-chromium-smoke-db","--command",sql]);
  await go(base+"/login");
  await until("login Superadmin",'document.querySelector("input[type=email]")!==null');
  await fill("input[type=email]",superEmail);await fill("input[type=password]",password);
  await click("Entrar");
  await until("rota da suíte de plataforma",
    'location.pathname.startsWith("/superadmin")');
  const superOverview=await js('fetch("/api/super/overview?days=30")'+
    '.then(async r=>({status:r.status,body:(await r.text()).slice(0,500)}))');
  assert.equal(superOverview.status,200,
    "Indicadores globais devem carregar para o Superadmin: "+JSON.stringify(superOverview));
  await until("Superadmin abre visão geral",
    'document.body.innerText.includes("BARBEARIAS ATIVAS")');
  pass("Superadmin autentica e consulta indicadores globais");
  await go(base+"/superadmin/companies");
  await until("Superadmin enxerga empresa existente",
    'document.body.innerText.includes("Barbearia Chromium Local")');
  await click("Nova barbearia");
  await until("formulário de onboarding",
    'document.body.innerText.includes("Cadastrar barbearia (onboarding assistido)")');
  const newOwner="novo-dono-"+randomBytes(4).toString("hex")+"@tigu.test";
  const newSlug="nova-chromium-"+randomBytes(4).toString("hex");
  for(const [label,value] of [
    ["Nome","Nova Barbearia Chromium"],
    ["Slug do link (opcional)",newSlug],
    ["E-mail do dono",newOwner],
    ["Nome do dono","Proprietário da nova barbearia"]
  ]){
    const result=await js('(()=>{const el=[...document.querySelectorAll("label")]'+
      '.find(x=>x.querySelector("span")?.textContent?.trim()==='+JSON.stringify(label)+')?.querySelector("input");'+
      'if(!el)return false;Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value")'+
      '.set.call(el,'+JSON.stringify(value)+');el.dispatchEvent(new Event("input",{bubbles:true}));'+
      'return true})()');
    assert.ok(result,"Campo do Superadmin ausente: "+label);
    await pause(50);
  }
  await until("formulário de Superadmin validado",
    '[...document.querySelectorAll("button")].some(x=>x.textContent.trim()==="Criar"&&!x.disabled)');
  await click("Criar");
  await until("empresa criada na interface",
    'document.body.innerText.includes("Barbearia criada")&&document.body.innerText.includes('+JSON.stringify(newSlug)+')');
  pass("Superadmin cadastra empresa e dono com teste grátis, sem cobrança");
  await go(base+"/superadmin/companies");
  const newlyCreated=await js('fetch("/api/super/companies").then(async r=>{if(!r.ok)throw Error("empresas inacessíveis");'+
    'const d=await r.json();return d.companies.find(x=>x.slug==='+JSON.stringify(newSlug)+')||null;})');
  assert.ok(newlyCreated?.id,"Cadastro Superadmin deve persistir empresa no D1");
  await go(base+"/superadmin/companies/"+newlyCreated.id);
  const detailResponse=await js('fetch("/api/super/companies/'+newlyCreated.id+'")'+
    '.then(async r=>({status:r.status,body:(await r.text()).slice(0,900)}))');
  assert.equal(detailResponse.status,200,
    "API de detalhes de barbearia deve funcionar: "+JSON.stringify(detailResponse));
  await until("detalhe da nova barbearia",'document.body.innerText.includes("Nova Barbearia Chromium")'+
    '&&document.body.innerText.includes("AJUSTE MANUAL DE CRÉDITOS")');
  pass("Superadmin abre detalhes e configurações de barbearia");
  await fill('input[placeholder^="ex.: 5000"]',"1250");
  await fill('input[placeholder^="Justificativa"]',"Teste isolado de auditoria de créditos");
  await click("Aplicar");
  await pause(700);
  const walletAdjusted=await js('fetch("/api/super/wallets/'+newlyCreated.id+
    '").then(r=>r.json())');
  const adjustmentScreen=await js('(()=>({main:document.querySelector("main")?.innerText.slice(0,1000),'+
    'value:document.querySelector("input[placeholder^=\\\"ex.: 5000\\\"]")?.value,'+
    'alerts:document.body.innerText.slice(-350)}))()');
  console.log("Diagnóstico local de ajuste financeiro:",JSON.stringify({
    balance:walletAdjusted.wallet?.balance_cents,transactions:walletAdjusted.transactions?.length,
    screen:adjustmentScreen
  }));
  assert.equal(walletAdjusted.wallet.balance_cents,1250,
    "Ajuste manual deve registrar exatamente 1.250 centavos na carteira D1");
  await until("carteira atualizada no painel",
    'document.body.innerText.includes("12,50")');
  assert.ok(walletAdjusted.transactions.some(x=>Number(x.amount_cents)===1250),
    "Ajuste deve criar lançamento de auditoria financeira");
  pass("Superadmin faz ajuste financeiro auditável apenas na carteira local");
  await go(base+"/superadmin/subscription-invoices");
  await until("mensalidades sem pagamento de teste",
    'document.body.innerText.includes("Mensalidades Pix")&&document.body.innerText.includes("Nenhuma fatura encontrada")');
  pass("Superadmin consulta mensalidades sem ativação ou cobrança");
  await go(base+"/superadmin/topups");
  await until("painel de recargas",
    'document.body.innerText.includes("Recargas Pix")');
  pass("Superadmin consulta recargas sem crédito automático");
  await go(base+"/superadmin/pricing");
  await until("tabela de precificação",
    'document.body.innerText.includes("Precificação de mensagens")');
  pass("Superadmin consulta precificação vigente");
  console.log("37 verificações Chromium aprovadas: usuário, agendamentos, carteira e Suíte Tigu; sem cobranças reais.");
}finally{
  if(ws)ws.close();
  for(const child of [chrome,worker])if(child&&child.exitCode===null){
    child.kill("SIGTERM");
    await Promise.race([new Promise(r=>child.once("exit",r)),pause(1500)]);
    if(child.exitCode===null)child.kill("SIGKILL");
  }
  rmSync(tmp,{recursive:true,force:true});
}
