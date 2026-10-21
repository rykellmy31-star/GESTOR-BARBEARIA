/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import initial from "../migrations/0001_init.sql";
import rateLimits from "../migrations/0006_request_rate_limits.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import type { Env } from "../api/types";

const db = env.DB as D1Database;
const e = {...env, APP_ENV:"development", SESSION_SECRET:"privacy-test-session-secret-32-characters"} as Env;
const ctx = {waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeAll(async () => {
  for(const sql of (initial+"\n"+rateLimits).replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean))
    await db.prepare(sql).run();
});
async function fixture() {
  const suffix=crypto.randomUUID().replaceAll("-","");
  const companySlug="lgpd-"+suffix;
  const companyId=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Barbearia Teste LGPD')")
    .bind(companySlug).run()).meta.last_row_id);
  const uid=Number((await db.prepare("INSERT INTO users(name,email,password_hash) VALUES ('Dono',?1,'hash')")
    .bind(suffix+"@tigu.test").run()).meta.last_row_id);
  const token=crypto.randomUUID();
  const tokenHash=await sha256hex(`${token}:${e.SESSION_SECRET}:${uid}`);
  const phone="739"+suffix.slice(0,8).replace(/[a-f]/g,"5").padEnd(8,"0");
  const customerName="Cliente Pessoal "+suffix.slice(0,8);
  await db.batch([
    db.prepare("INSERT INTO company_memberships(company_id,user_id,role) VALUES (?1,?2,'owner')").bind(companyId,uid),
    db.prepare("INSERT INTO subscriptions(company_id,plan_code,status,period_end) VALUES (?1,'free','active','2099-01-01T00:00:00Z')").bind(companyId),
    db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,'2099-01-01T00:00:00Z')").bind(tokenHash,uid),
  ]);
  const barberId=Number((await db.prepare("INSERT INTO barbers(company_id,slug,name) VALUES (?1,'barber','Barbeiro')")
    .bind(companyId).run()).meta.last_row_id);
  const serviceId=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',3000,30)")
    .bind(companyId).run()).meta.last_row_id);
  const customerId=Number((await db.prepare(`INSERT INTO customers(company_id,name,phone,email,notes,whatsapp_optin,lgpd_consent_at)
    VALUES (?1,?2,?3,'pessoal@exemplo.test','Dados pessoais nos comentários',1,'2026-01-01T00:00:00Z')`)
    .bind(companyId,customerName,phone).run()).meta.last_row_id);
  const cookie=`aurum_session=uid.${uid}.${token}`;
  const endpoint=`/api/c/${companySlug}/admin/customers/${customerId}/anonymize`;
  const req=(method="POST")=>app.request(endpoint,{method,headers:{"content-type":"application/json",cookie},
    body:method==="POST"?"{}":undefined},e,ctx);
  return {companyId,companySlug,customerId,customerName,phone,barberId,serviceId,cookie,req};
}
async function booking(f: Awaited<ReturnType<typeof fixture>>,status="cancelado"){
  const id=Number((await db.prepare(`INSERT INTO bookings(company_id,code,customer_id,barber_id,service_id,
    starts_at,ends_at,price_cents,status,customer_name,customer_phone,customer_email,notes,whatsapp_optin,cancel_token)
    VALUES (?1,?2,?3,?4,?5,'2099-01-10T10:00:00Z','2099-01-10T10:30:00Z',3000,?6,?7,?8,
    'pessoal@exemplo.test','Nota com telefone pessoal',1,'token-de-cancelamento')`)
    .bind(f.companyId,"B"+crypto.randomUUID().slice(0,12),f.customerId,f.barberId,f.serviceId,status,f.customerName,f.phone).run()).meta.last_row_id);
  return id;
}

describe("LGPD: anonimização de dados operacionais por empresa",()=>{
  it("descaracteriza cadastro, reservas, avaliações, pedidos e mensagens sem alterar valores",async()=>{
    const f=await fixture(),bookingId=await booking(f,"concluido");
    const orderId=Number((await db.prepare(`INSERT INTO orders(company_id,code,customer_name,customer_phone,status,total_cents)
      VALUES (?1,?2,?3,?4,'pago',4000)`)
      .bind(f.companyId,"O"+crypto.randomUUID().slice(0,12),f.customerName,f.phone).run()).meta.last_row_id);
    await db.batch([
      db.prepare("INSERT INTO reviews(company_id,barber_id,booking_id,customer_name,rating,comment) VALUES (?1,?2,?3,?4,5,'Avaliacao com dados')").bind(f.companyId,f.barberId,bookingId,f.customerName),
      db.prepare(`INSERT INTO message_jobs(company_id,booking_id,to_phone,template_code,payload_json,
        scheduled_at,fire_deadline,status,idempotency_key)
        VALUES (?1,?2,?3,'teste',?4,'2099-01-10T00:00:00Z','2099-01-10T01:00:00Z','scheduled',?5)`)
        .bind(f.companyId,bookingId,f.phone,JSON.stringify({customer:f.customerName,contact:f.phone}),crypto.randomUUID()),
      db.prepare("INSERT INTO notifications(company_id,audience,booking_id,title,body) VALUES (?1,'admin',?2,'Aviso',?3)").bind(f.companyId,bookingId,f.customerName),
    ]);
    const res=await f.req();expect(res.status).toBe(200);
    const cust=await db.prepare("SELECT * FROM customers WHERE id=?1").bind(f.customerId).first<Record<string,unknown>>();
    const anonPhone=`anon-${f.companyId}-${f.customerId}`;
    expect(cust).toMatchObject({name:"Cliente anonimizado",phone:anonPhone,email:null,notes:"",
      whatsapp_optin:0,lgpd_consent_at:null});
    expect(cust?.anonymized_at).toBeTruthy();
    expect(await db.prepare("SELECT customer_name,customer_phone,customer_email,notes,whatsapp_optin,cancel_token,price_cents FROM bookings WHERE id=?1").bind(bookingId).first())
      .toMatchObject({customer_name:"Cliente anonimizado",customer_phone:anonPhone,customer_email:null,
        notes:"",whatsapp_optin:0,cancel_token:"",price_cents:3000});
    expect(await db.prepare("SELECT customer_name,customer_phone,total_cents FROM orders WHERE id=?1").bind(orderId).first())
      .toEqual({customer_name:"Cliente anonimizado",customer_phone:anonPhone,total_cents:4000});
    expect(await db.prepare("SELECT customer_name,comment,rating FROM reviews WHERE booking_id=?1").bind(bookingId).first())
      .toEqual({customer_name:"Cliente anonimizado",comment:"",rating:5});
    expect(await db.prepare("SELECT to_phone,payload_json,status,skip_reason FROM message_jobs WHERE booking_id=?1").bind(bookingId).first())
      .toEqual({to_phone:"",payload_json:"{}",status:"skipped",skip_reason:"anonimização LGPD"});
    expect(await db.prepare("SELECT body FROM notifications WHERE booking_id=?1").bind(bookingId).first("body")).toBe("");
    const data=await app.request(`/api/c/${f.companySlug}/admin/customers`,{headers:{cookie:f.cookie}},e,ctx);
    expect(data.status).toBe(200);
    const list=await data.json() as {customers: {id:number;visits:number;completed:number;spent_cents:number}[]};
    expect(list.customers.find(x=>x.id===f.customerId)).toMatchObject({visits:1,completed:1,spent_cents:7000});
    expect((await f.req()).status).toBe(409);
    // O titular poderá voltar a reservar com o mesmo telefone e obter novo cadastro.
    await db.prepare("INSERT INTO customers(company_id,name,phone) VALUES (?1,'Novo consentimento',?2)").bind(f.companyId,f.phone).run();
    expect(await db.prepare("SELECT COUNT(*) n FROM customers WHERE company_id=?1").bind(f.companyId).first("n")).toBe(2);
  });
  it("recusa reservas ativas, pedidos novos ou mensagens em envio",async()=>{
    const active=await fixture();await booking(active,"confirmado");
    expect((await active.req()).status).toBe(409);
    const pending=await fixture();
    await db.prepare("INSERT INTO orders(company_id,code,customer_name,customer_phone,status,total_cents) VALUES (?1,?2,'Cliente',?3,'novo',100)")
      .bind(pending.companyId,"O"+crypto.randomUUID().slice(0,12),pending.phone).run();
    expect((await pending.req()).status).toBe(409);
    const sending=await fixture(),bid=await booking(sending,"cancelado");
    await db.prepare(`INSERT INTO message_jobs(company_id,booking_id,to_phone,template_code,scheduled_at,fire_deadline,status,idempotency_key)
      VALUES (?1,?2,?3,'teste','2099-01-10T00:00:00Z','2099-01-10T01:00:00Z','sending',?4)`)
      .bind(sending.companyId,bid,sending.phone,crypto.randomUUID()).run();
    expect((await sending.req()).status).toBe(409);
    for(const f of [active,pending,sending]){
      expect(await db.prepare("SELECT anonymized_at,phone FROM customers WHERE id=?1").bind(f.customerId).first())
        .toEqual({anonymized_at:null,phone:f.phone});
    }
  });
  it("impede que o administrador de outra empresa anonimize o titular",async()=>{
    const a=await fixture(),b=await fixture();
    const foreign=await app.request(`/api/c/${a.companySlug}/admin/customers/${a.customerId}/anonymize`,{
      method:"POST",headers:{"content-type":"application/json",cookie:b.cookie},body:"{}",
    },e,ctx);
    expect(foreign.status).toBe(403);
    expect(await db.prepare("SELECT phone FROM customers WHERE id=?1").bind(a.customerId).first("phone")).toBe(a.phone);
  });
});
