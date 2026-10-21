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
  const barberFromPanel=(await owner("GET",c+"/admin/barbers")).data.barbers.find(item=>item.id===bid);
  check("Painel Equipe recebe dias válidos e serviços vinculados",
    Array.isArray(barberFromPanel?.work_days)&&barberFromPanel.work_days.length===7&&
    Array.isArray(barberFromPanel.service_ids)&&barberFromPanel.service_ids.includes(service.data.id));
  const editBarber=await owner("PUT",c+"/admin/barbers/"+bid,{
    name:"Barbeiro local atualizado",work_days:barberFromPanel.work_days,
    service_ids:barberFromPanel.service_ids
  });
  const barberAfterEdit=(await owner("GET",c+"/admin/barbers")).data.barbers.find(item=>item.id===bid);
  check("Editar profissional não apaga serviços da agenda",
    editBarber.status===200&&barberAfterEdit.service_ids.includes(service.data.id));
  const publicServices=await visitor("GET",c+"/services");
  check("Agendamento lista profissionais associados ao serviço público",
    publicServices.status===200&&publicServices.data.services.some(item=>
      item.id===service.data.id&&Array.isArray(item.barber_ids)&&item.barber_ids.includes(bid)));
  const publicBarber=await visitor("GET",c+"/barbers/"+bid);
  check("Perfil público do profissional carrega antes da confirmação",
    publicBarber.status===200&&publicBarber.data.barber.id===bid&&publicBarber.data.barber.name==="Barbeiro local atualizado");
  const otherSlug=second.data.company.slug;
  check("Outra empresa não consegue acessar perfil do profissional",
    (await visitor("GET","/api/c/"+otherSlug+"/barbers/"+bid)).status===404);
  const staff=client(),staffEmail="staff@local-e2e.test",staffPassword=`Equipe!${randomBytes(12).toString("hex")}`;
  const createdStaff=await owner("POST",c+"/admin/team",{name:"Gerente local",email:staffEmail,password:staffPassword,role:"manager"});
  const team=(await owner("GET",c+"/admin/team")).data.team;
  const memberId=team.find(member=>member.email===staffEmail)?.membership_id;
  check("Cadastro de equipe cria conta e vínculo",createdStaff.status===201&&!!memberId);
  const staffLogin=await staff("POST","/api/auth/login",{email:staffEmail,password:staffPassword});
  check("Equipe com senha provisória precisa alterá-la antes de acessar painel",staffLogin.status===200&&staffLogin.data.user.must_change_password&&(await staff("GET",c+"/admin/dashboard")).status===403);
  const staffFinalPassword=`EquipeNova!${randomBytes(12).toString("hex")}`;
  check("Troca da senha provisória libera o papel de gerente",(await staff("POST","/api/auth/password",{current:staffPassword,next:staffFinalPassword})).status===200&&(await staff("GET",c+"/admin/dashboard")).status===200);
  check("Remoção da equipe revoga a sessão existente",(await owner("PUT",c+`/admin/team/${memberId}`,{active:false})).status===200&&(await staff("GET",c+"/admin/dashboard")).status===401);
  check("Reativação restaura vínculo sem trocar credencial",(await owner("PUT",c+`/admin/team/${memberId}`,{active:true})).status===200&&(await staff("POST","/api/auth/login",{email:staffEmail,password:staffFinalPassword})).status===200&&(await staff("GET",c+"/admin/dashboard")).status===200);
  const staffResetPassword=`EquipeReset!${randomBytes(12).toString("hex")}`;
  const resetStaff=await owner("PUT",c+`/admin/team/${memberId}`,{reset_password:staffResetPassword});
  const oldStaffLogin=await staff("POST","/api/auth/login",{email:staffEmail,password:staffFinalPassword});
  const newStaffLogin=await staff("POST","/api/auth/login",{email:staffEmail,password:staffResetPassword});
  check("Reset da equipe invalida senha antiga e exige nova troca",resetStaff.status===200&&oldStaffLogin.status===401&&newStaffLogin.status===200&&newStaffLogin.data.user.must_change_password&&(await staff("GET",c+"/admin/dashboard")).status===403);
  const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
  const availability=await visitor("GET",c+`/availability?barberId=${bid}&serviceId=${service.data.id}&day=${day}`);
  const free=availability.data.slots.filter(slot=>slot.available);
  check("Disponibilidade pública contém horários reais",availability.status===200&&free.length>=3);
  const booking=await visitor("POST",c+"/bookings",{barberId:bid,serviceId:service.data.id,startsAt:free[0].t,name:"Cliente local",phone:"5573999990000",consent:true,whatsappOptin:false,idempotencyKey:randomBytes(16).toString("hex")});
  check("Agendamento público confirmado na API",booking.status===201&&booking.data.booking.id>0);
  const bookingLookup=await visitor("POST",c+"/bookings/lookup",{code:booking.data.booking.code,phone:"5573999990000"});
  check("Cliente encontra reserva com IDs de serviço e barbeiro para remarcar",
    bookingLookup.status===200&&bookingLookup.data.bookings[0]?.service_id===service.data.id&&
    bookingLookup.data.bookings[0]?.barber_id===bid);
  check("Consulta de reserva não vaza para outra barbearia",
    (await visitor("POST","/api/c/"+otherSlug+"/bookings/lookup",{code:booking.data.booking.code,phone:"5573999990000"})).status===404);
  const bookingId=booking.data.booking.id;
  const moved=await owner("POST",c+`/admin/bookings/${bookingId}/reschedule`,{startsAt:free[2].t});
  check("Remarcação aplica versão e slots novos",moved.status===200);
  const laterDay=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
  const laterSlots=await visitor("GET",c+`/availability?barberId=${bid}&serviceId=${service.data.id}&day=${laterDay}`);
  const laterFree=laterSlots.data.slots?.filter(slot=>slot.available) ?? [];
  check("Cliente consulta opções de remarcação em outro dia",laterSlots.status===200&&laterFree.length>0);
  const changedByClient=await visitor("POST",c+"/bookings/reschedule",{
    code:booking.data.booking.code,phone:"5573999990000",startsAt:laterFree[0].t
  });
  const afterClient=await visitor("POST",c+"/bookings/lookup",{code:booking.data.booking.code,phone:"5573999990000"});
  check("Cliente remarca para outro dia e consulta o horário novo",
    changedByClient.status===200&&afterClient.status===200&&
    afterClient.data.bookings[0]?.starts_at===laterFree[0].t);
  check("Protocolo com telefone incorreto não revela a reserva",
    (await visitor("POST",c+"/bookings/lookup",{code:booking.data.booking.code,phone:"5573999993333"})).status===404);
  check("Cancelamento libera o atendimento",(await owner("POST",c+`/admin/bookings/${bookingId}/cancel`,{reason:"Validação local"})).status===200);
  check("Atendimento cancelado não pode ser restaurado por status",(await owner("PUT",c+`/admin/bookings/${bookingId}/status`,{status:"confirmado"})).status===409);
  const product=await owner("POST",c+"/admin/products",{name:"Pomada local",price_cents:2500,stock:3});
  const editStock=await owner("PUT",c+"/admin/products/"+product.data.id,{price_cents:2450,adjust_stock_by:1,stock_reason:"Compra de reposição"});
  check("Painel edita produto e movimenta estoque com histórico",editStock.status===200&&
    (await owner("GET",c+"/admin/products")).data.products.find(item=>item.id===product.data.id).stock===4);
  const stockRevert=await owner("PUT",c+"/admin/products/"+product.data.id,{price_cents:2500,adjust_stock_by:-1,stock_reason:"Ajuste de inventário"});
  check("Painel corrige estoque e preço com dados atômicos",stockRevert.status===200&&
    (await owner("GET",c+"/admin/products")).data.products.find(item=>item.id===product.data.id).stock===3);
  const catalogue=await visitor("GET",c+"/products");
  check("Cliente vê produto ativo, preço e estoque no catálogo",product.status===200&&catalogue.status===200&&
    catalogue.data.products.some(item=>item.id===product.data.id&&item.stock===3&&item.price_cents===2500));
  const order=await visitor("POST",c+"/orders",{name:"Cliente local",phone:"5573999990000",items:[{productId:product.data.id,qty:2}]});
  check("Cliente finaliza pedido sem pagamento automático",order.status===201&&order.data.total===50);
  const orders=(await owner("GET",c+"/admin/orders")).data.orders;
  const found=orders.find(item=>item.code===order.data.code);
  const orderId=found?.id;
  check("Painel mostra pedido, quantidade e valor corretos",!!orderId&&found.status==="novo"&&found.total_cents===5000&&
    found.items?.length===1&&found.items[0].qty===2&&found.items[0].unit_price_cents===2500);
  check("Pedido reserva estoque ao chegar, sem aguardar pagamento",(await owner("GET",c+"/admin/products")).data.products
    .find(item=>item.id===product.data.id).stock===1);
  const paid=await owner("PATCH",c+"/admin/orders/"+orderId+"/status",{status:"pago"});
  check("Pagamento manual não baixa estoque pela segunda vez",paid.status===200&&
    (await owner("GET",c+"/admin/products")).data.products.find(item=>item.id===product.data.id).stock===1);
  const delivered=await owner("PATCH",c+"/admin/orders/"+orderId+"/status",{status:"entregue"});
  check("Entrega concluída bloqueia reabertura indevida",delivered.status===200&&
    (await owner("PATCH",c+"/admin/orders/"+orderId+"/status",{status:"novo"})).status===409);
  const cancellation=await visitor("POST",c+"/orders",{name:"Outro cliente",phone:"5573999991111",items:[{productId:product.data.id,qty:1}]});
  const nextOrders=(await owner("GET",c+"/admin/orders")).data.orders;
  const cancelledId=nextOrders.find(item=>item.code===cancellation.data.code)?.id;
  check("Cancelamento devolve estoque ao catálogo",cancellation.status===201&&!!cancelledId&&
    (await owner("POST",c+"/admin/orders/"+cancelledId+"/status",{status:"cancelado"})).status===200&&
    (await visitor("GET",c+"/products")).data.products.find(item=>item.id===product.data.id).stock===1);
  const empty=await owner("POST",c+"/admin/products",{name:"Produto esgotado",price_cents:100,stock:0});
  const unavailable=await visitor("POST",c+"/orders",{name:"Cliente",phone:"5573999992222",items:[{productId:empty.data.id,qty:1}]});
  check("Produto sem estoque aparece na loja mas não aceita pedido",empty.status===200&&unavailable.status===409&&
    (await visitor("GET",c+"/products")).data.products.some(item=>item.id===empty.data.id&&item.stock===0));
  const removal=await owner("DELETE",c+"/admin/products/"+empty.data.id);
  const removedFromCatalog=await visitor("GET",c+"/products");
  check("Painel desativa produto sem apagar estoque histórico",removal.status===200&&
    !removedFromCatalog.data.products.some(item=>item.id===empty.data.id)&&
    (await owner("GET",c+"/admin/products")).data.products.some(item=>item.id===empty.data.id&&item.active===0));
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

  // Testa historico além do limite inicial em uma base D1 local descartável.
  const historySql = "WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<205) " +
    "INSERT INTO message_jobs(company_id,to_phone,template_code,scheduled_at,fire_deadline,status,idempotency_key,last_error) " +
    "SELECT (SELECT id FROM companies WHERE slug="+q(slug)+"),'5573999990000','manual'," +
    "'2026-01-01T00:00:00Z','2026-01-02T00:00:00Z','failed','e2e-history-'+i," +
    "CASE WHEN i=1 THEN '[CONFLITO META: falha divergente]' ELSE '' END FROM seq";
  wrangler(["d1","execute","tigu-local-e2e-db","--command",historySql]);
  const firstPage = await superadmin("GET","/api/super/messages");
  check("Fila global informa cursor após 100 mensagens",
    firstPage.status===200 && firstPage.data.jobs.length===100 &&
    Number.isSafeInteger(firstPage.data.next_before_id));
  const secondPage = await superadmin("GET","/api/super/messages?beforeId="+firstPage.data.next_before_id);
  check("Página seguinte entrega 100 mensagens sem duplicação",
    secondPage.status===200 && secondPage.data.jobs.length===100 &&
    !secondPage.data.jobs.some(x=>firstPage.data.jobs.some(y=>y.id===x.id)));
  const thirdPage = await superadmin("GET","/api/super/messages?beforeId="+secondPage.data.next_before_id);
  check("Fila permite percorrer registros além dos primeiros 200",
    thirdPage.status===200 && thirdPage.data.jobs.length>=5);
  const conflictPage = await superadmin("GET","/api/super/messages?status=conflict");
  check("Conflito antigo encontrado por filtro na API",
    conflictPage.status===200 && conflictPage.data.jobs.some(x=>x.last_error?.includes("[CONFLITO META:")));
  check("Cursor inválido é rejeitado",(await superadmin("GET","/api/super/messages?beforeId=-1")).status===400);
  const invalidTenant = await Promise.all(["0","NaN","9007199254740992"].map(value=>
    superadmin("POST","/api/super/messages/run-cron?companyId="+value,{})));
  check("Cron manual rejeita empresa inválida sem processar fila global",
    invalidTenant.every(x=>x.status===400));
  // Homologação financeira direta via Worker+D1, não apenas testes unitários.
  const financeInitial=await superadmin("GET","/api/super/settings");
  const pricing=financeInitial.data.settings;
  check("Superadmin lê os limites financeiros da plataforma",
    financeInitial.status===200 && Number.isSafeInteger(pricing.topup_min_cents) &&
    pricing.topup_max_cents>=pricing.topup_min_cents);
  const badAttempts=await superadmin("PUT","/api/super/settings",{key:"msg_max_attempts",value:0});
  check("HTTP impede número de tentativas inválido",badAttempts.status===422);
  const badText=await superadmin("PUT","/api/super/settings",{key:"topup_min_cents",value:"1000"});
  check("HTTP impede valores financeiros enviados como texto",badText.status===422);
  const badFloor=await superadmin("PUT","/api/super/settings",{key:"topup_min_cents",value:pricing.topup_max_cents+1});
  check("HTTP recusa recarga mínima maior que máxima",badFloor.status===422);
  const badCeiling=await superadmin("PUT","/api/super/settings",{key:"topup_max_cents",value:pricing.topup_min_cents-1});
  check("HTTP recusa recarga máxima menor que mínima",badCeiling.status===422);
  const goodAttempts=await superadmin("PUT","/api/super/settings",{key:"msg_max_attempts",value:4});
  const financeUpdated=await superadmin("GET","/api/super/settings");
  check("HTTP aceita ajuste válido e grava no D1",goodAttempts.status===200 &&
    financeUpdated.status===200 && financeUpdated.data.settings.msg_max_attempts===4);
  const race=await Promise.all([
    superadmin("PUT","/api/super/settings",{key:"topup_min_cents",value:4000}),
    superadmin("PUT","/api/super/settings",{key:"topup_max_cents",value:2000}),
  ]);
  const afterRace=await superadmin("GET","/api/super/settings");
  check("Gravações concorrentes preservam consistência dos limites de recarga",
    race.every(x=>x.status===200||x.status===422) && race.some(x=>x.status===200) &&
    race.some(x=>x.status===422) && afterRace.status===200 &&
    afterRace.data.settings.topup_min_cents<=afterRace.data.settings.topup_max_cents);
  console.log(`\n${checks} verificações HTTP locais aprovadas. Nenhum deploy, pagamento ou envio real.`);
} catch(error) {
  console.error(error.message);process.exitCode=1;
} finally {
  if(worker&&worker.exitCode===null){worker.kill("SIGTERM");await Promise.race([new Promise(resolveExit=>worker.once("exit",resolveExit)),new Promise(resolveTimeout=>setTimeout(resolveTimeout,5000))]);if(worker.exitCode===null)worker.kill("SIGKILL");}
  rmSync(tmp,{recursive:true,force:true});
}
