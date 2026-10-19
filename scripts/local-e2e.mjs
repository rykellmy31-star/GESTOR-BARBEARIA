#!/usr/bin/env node
/** HTTP local com Worker, assets, D1 e R2 efêmeros; nunca aceita URL ou flag remota. */
import assert from "node:assert/strict";
import { spawn,execFileSync } from "node:child_process";
import { mkdtempSync,writeFileSync,rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join,resolve } from "node:path";
import { createServer } from "node:net";
import { randomBytes,pbkdf2Sync } from "node:crypto";
if(process.argv.length!==2)throw Error("Este teste só aceita execução local sem argumentos.");
const root=resolve(import.meta.dirname,".."),tmp=mkdtempSync(join(tmpdir(),"tigu-local-e2e-"));
const config=join(tmp,"wrangler.json"),state=join(tmp,"state");
const cli=join(root,"node_modules/wrangler/bin/wrangler.js");
const childEnv={...process.env,CI:"true",WRANGLER_SEND_METRICS:"false",CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV:"false"};
const superEmail="super@local-e2e.test",superPassword=`Local!${randomBytes(16).toString("hex")}`;
writeFileSync(config,JSON.stringify({
  name:"tigu-local-e2e",main:join(root,"api/index.ts"),compatibility_date:"2025-01-01",compatibility_flags:["nodejs_compat"],
  vars:{APP_ENV:"development",TIGU_STAGING:"1",WHATSAPP_MOCK:"1",PAYMENTS_MOCK:"0",GRAPH_API_VERSION:"v23.0",SESSION_SECRET:randomBytes(32).toString("hex"),MSG_ENC_KEY:randomBytes(32).toString("hex")},
  assets:{directory:join(root,"dist"),binding:"ASSETS",not_found_handling:"single-page-application",run_worker_first:["/api/*","/uploads/*"]},
  d1_databases:[{binding:"DB",database_name:"tigu-local-e2e-db",database_id:"00000000-0000-4000-8000-000000000099",migrations_dir:join(root,"migrations")}],
  r2_buckets:[{binding:"MEDIA",bucket_name:"tigu-local-e2e-media"}],
}));
function wrangler(args){
  try {return execFileSync(process.execPath,[cli,...args,"--local","--config",config,"--persist-to",state],{cwd:root,env:childEnv,encoding:"utf8",timeout:120000,maxBuffer:8*1024*1024});}
  catch {throw Error("Falha no Wrangler local. Nenhuma operação remota foi solicitada.");}
}
const q=value=>`'${String(value).replace(/'/g,"''")}'`;
let worker,checks=0;
const check=(name,condition)=>{assert.ok(condition,name);checks++;console.log(`✔ ${name}`);};
try {
  wrangler(["d1","migrations","apply","tigu-local-e2e-db"]);
  const salt=randomBytes(16),hash=pbkdf2Sync(superPassword,salt,150000,32,"sha256");
  const stored=`pbkdf2_sha256$150000$${salt.toString("base64")}$${hash.toString("base64")}`;
  wrangler(["d1","execute","tigu-local-e2e-db","--command",`INSERT INTO users(platform_role,name,email,password_hash) VALUES ('superadmin','Super local',${q(superEmail)},${q(stored)})`]);
  const port=await new Promise((resolvePort,reject)=>{const server=createServer();server.on("error",reject);server.listen(0,"127.0.0.1",()=>{const selected=server.address().port;server.close(()=>resolvePort(selected));});});
  const base=`http://127.0.0.1:${port}`;
  worker=spawn(process.execPath,[cli,"dev","--local","--config",config,"--persist-to",state,"--ip","127.0.0.1","--port",String(port),"--inspector-port","0"],{cwd:root,env:childEnv,stdio:["ignore","pipe","pipe"]});
  worker.stdout.resume();worker.stderr.resume();
  let health;
  for(let i=0;i<180;i++){
    if(worker.exitCode!==null)throw Error("Worker local encerrou antes de iniciar.");
    try {const res=await fetch(base+"/api/health",{signal:AbortSignal.timeout(1000)});if(res.ok){health=await res.json();break;}}catch{}
    await new Promise(resolveWait=>setTimeout(resolveWait,250));
  }
  check("Worker local com D1/R2 e pagamentos reais bloqueados",health?.ok&&health.d1&&health.r2&&health.staging&&!health.payments.mercadopago&&!health.payments.mock);
  function client(){let cookie="";return async(method,path,body)=>{
    const multipart=body instanceof FormData;
    const response=await fetch(base+path,{method,redirect:"manual",signal:AbortSignal.timeout(10000),headers:{...(multipart?{}:{"content-type":"application/json"}),origin:base,...(cookie?{cookie}:{})},body:body===undefined?undefined:multipart?body:JSON.stringify(body)});
    const set=response.headers.getSetCookie();if(set.length)cookie=set.map(value=>value.split(";")[0]).join("; ");
    const text=await response.text();let data;try{data=JSON.parse(text);}catch{data=text;}
    return {status:response.status,data,headers:response.headers};
  };}
  const visitor=client(),owner=client(),other=client(),superadmin=client();
  const home=await visitor("GET","/");check("HTML de vendas servido pelo build local",home.status===200&&typeof home.data==="string"&&home.data.includes('id="root"'));
  check("Página não envia endereço de navegação como referrer",home.data.includes('<meta name="referrer" content="no-referrer"'));
  const password=`Teste!${randomBytes(12).toString("hex")}`,email="owner@local-e2e.test";
  const signup=await owner("POST","/api/auth/register",{company_name:"Barbearia Local E2E",name:"Dono local",email,password});
  check("Cadastro cria empresa e sessão",signup.status===201&&!!signup.data.company?.slug);
  const slug=signup.data.company.slug,c=`/api/c/${slug}`;
  const billing=await owner("GET",c+"/billing/status"),sub=billing.data.subscription;
  const session=await owner("GET","/api/auth/me");
  check("Cadastro, sessão e cobrança não permitem armazenamento em cache",[signup,session,billing].every(result=>result.headers.get("cache-control")==="no-store"&&result.headers.get("x-content-type-options")==="nosniff"));
  const image=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uoAAAAASUVORK5CYII=","base64");
  const photo=new FormData();photo.append("file",new Blob([image],{type:"image/png"}),"foto.png");
  const uploaded=await owner("POST",c+"/admin/upload",photo);
  assert.equal(uploaded.status,201,"Upload PNG local deve funcionar");
  const served=await fetch(base+uploaded.data.url,{signal:AbortSignal.timeout(10000)});
  check("Foto percorre HTTP, R2 local e retorno protegido",served.status===200&&served.headers.get("content-type")==="image/png"&&served.headers.get("x-content-type-options")==="nosniff"&&image.equals(Buffer.from(await served.arrayBuffer())));
  const fakePhoto=new FormData();fakePhoto.append("file",new Blob(["<script>alert(1)</script>"],{type:"image/png"}),"foto.png");
  check("Foto com tipo falsificado é recusada por HTTP",(await owner("POST",c+"/admin/upload",fakePhoto)).status===415);
  check("Teste grátis com duração exata de quinze dias",billing.status===200&&sub.status==="trial"&&Date.parse(sub.period_end)-Date.parse(sub.started_at)===15*86400000);
  check("Pix real continua indisponível",(await owner("POST",c+"/billing/pix",{plan_code:"free"})).status===503);
  const second=await other("POST","/api/auth/register",{company_name:"Segunda Local E2E",name:"Outro dono",email:"other@local-e2e.test",password});
  check("Outra barbearia não acessa o painel da primeira",second.status===201&&(await other("GET",c+"/admin/dashboard")).status===403);
  const settings=(await owner("GET",c+"/admin/settings")).data.settings;
  const updated={...settings,min_lead_min:0,opening_hours:Object.fromEntries([0,1,2,3,4,5,6].map(day=>[String(day),{open:"09:00",close:"18:00"}])),whatsapp_reminders_enabled:false,whatsapp_confirm_enabled:false};
  check("Configuração de horários salva",(await owner("PUT",c+"/admin/settings",updated)).status===200);
  const barber=await owner("POST",c+"/admin/barbers",{name:"Barbeiro local",work_days:[0,1,2,3,4,5,6],work_start:"09:00",work_end:"18:00",break_start:"12:00",break_end:"13:00",service_ids:[]});
  const bid=barber.data.id;
  const service=await owner("POST",c+"/admin/services",{name:"Corte local",price_cents:1999,duration_min:30,barber_ids:[bid]});
  check("Profissional e serviço vinculados",barber.status===200&&service.status===200);
  const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  const availability=await visitor("GET",c+`/availability?barberId=${bid}&serviceId=${service.data.id}&day=${day}`);
  const free=availability.data.slots.filter(slot=>slot.available);
  check("Disponibilidade pública contém horários reais",availability.status===200&&free.length>=3);
  const booking=await visitor("POST",c+"/bookings",{barberId:bid,serviceId:service.data.id,startsAt:free[0].t,name:"Cliente local",phone:"5573999990000",consent:true,whatsappOptin:false,idempotencyKey:randomBytes(16).toString("hex")});
  check("Agendamento público confirmado na API",booking.status===201&&booking.data.booking.id>0);
  const bookingId=booking.data.booking.id;
  const moved=await owner("POST",c+`/admin/bookings/${bookingId}/reschedule`,{startsAt:free[2].t});
  check("Remarcação aplica versão e slots novos",moved.status===200);
  check("Cancelamento libera o atendimento",(await owner("POST",c+`/admin/bookings/${bookingId}/cancel`,{reason:"Validação local"})).status===200);
  check("Atendimento cancelado não pode ser restaurado por status",(await owner("PUT",c+`/admin/bookings/${bookingId}/status`,{status:"confirmado"})).status===409);
  const product=await owner("POST",c+"/admin/products",{name:"Pomada local",price_cents:2500,stock:3});
  const order=await visitor("POST",c+"/orders",{name:"Cliente local",phone:"5573999990000",items:[{productId:product.data.id,qty:2}]});
  check("Pedido reserva estoque sem cobrar pagamento",product.status===200&&order.status===201);
  const orders=(await owner("GET",c+"/admin/orders")).data.orders;
  const orderId=orders.find(item=>item.code===order.data.code).id;
  check("Cancelar pedido devolve estoque",(await owner("POST",c+`/admin/orders/${orderId}/status`,{status:"cancelado"})).status===200&&
    (await owner("GET",c+"/admin/products")).data.products.find(item=>item.id===product.data.id).stock===3);
  const login=await superadmin("POST","/api/auth/login",{email:superEmail,password:superPassword});
  check("Superadmin local autentica",login.status===200&&login.data.user.platform_role==="superadmin");
  const assisted=await superadmin("POST","/api/super/companies",{name:"Assistida local",slug:"assistida-local",owner_name:"Dono assistido",owner_email:"assisted@local-e2e.test",plan_code:"pro"});
  check("Cadastro assistido entrega senha provisória e fim do teste",assisted.status===201&&!!assisted.data.generated_password&&!!assisted.data.trial_end);
  const expiring=await visitor("POST",c+"/bookings",{barberId:bid,serviceId:service.data.id,startsAt:free[0].t,name:"Cliente local",phone:"5573999990000",consent:true,whatsappOptin:false,idempotencyKey:randomBytes(16).toString("hex")});
  check("Reserva prévia preservada para teste de vencimento",expiring.status===201);
  wrangler(["d1","execute","tigu-local-e2e-db","--command",`UPDATE subscriptions SET period_end='2000-01-01T00:00:00Z' WHERE company_id=(SELECT id FROM companies WHERE slug=${q(slug)})`]);
  check("Teste vencido impede novas reservas sem cobrança automática",(await visitor("POST",c+"/bookings",{barberId:bid,serviceId:service.data.id,startsAt:free[2].t,name:"Cliente local",phone:"5573999990000",consent:true,whatsappOptin:false,idempotencyKey:randomBytes(16).toString("hex")})).status===402);
  check("Vencimento preserva consulta do painel e assinatura",(await owner("GET",c+"/admin/dashboard")).status===200&&(await owner("GET",c+"/billing/status")).status===200);
  check("Renovação permanece acessível mas Pix real bloqueado",(await owner("POST",c+"/billing/pix",{plan_code:"pro"})).status===503);
  check("Cliente ainda pode cancelar reserva existente após vencer o teste",(await visitor("POST",c+"/bookings/cancel",{code:expiring.data.booking.code,phone:"5573999990000"})).status===200);
  const uid=login.data.user.id;
  check("Último Superadmin não pode ser desativado",(await superadmin("PUT",`/api/super/users/${uid}`,{active:false})).status===409);
  check("Usuário comum não acessa o Superadmin",(await owner("GET","/api/super/overview")).status===403);
  console.log(`\n${checks} verificações HTTP locais aprovadas. Nenhum deploy, pagamento ou envio real.`);
} catch(error) {
  console.error(error.message);process.exitCode=1;
} finally {
  if(worker&&worker.exitCode===null){worker.kill("SIGTERM");await Promise.race([new Promise(resolveExit=>worker.once("exit",resolveExit)),new Promise(resolveTimeout=>setTimeout(resolveTimeout,5000))]);if(worker.exitCode===null)worker.kill("SIGKILL");}
  rmSync(tmp,{recursive:true,force:true});
}
