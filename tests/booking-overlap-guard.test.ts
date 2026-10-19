/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema1 from "../migrations/0001_init.sql";
import schema6 from "../migrations/0006_request_rate_limits.sql";
import guard from "../migrations/0008_booking_overlap_guard.sql";
import { createBooking, setBookingStatus } from "../api/lib/booking";
import { createAdminIntervalBlock } from "../api/lib/admin-blocks";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc } from "../api/lib/time";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"booking-overlap-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
let legacyBookingId=0,legacyCompanyId=0;
beforeAll(async()=>{
  for(const schema of [schema1,schema6]) for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  // Representa dados antigos anteriores à migração; a migração não deve apagá-los.
  legacyCompanyId=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES ('legacy-overlap','Legado')").run()).meta.last_row_id);
  const barber=Number((await db.prepare("INSERT INTO barbers(company_id,slug,name) VALUES (?1,'legado','Legado')").bind(legacyCompanyId).run()).meta.last_row_id);
  const service=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'legado','Corte',1000,15)").bind(legacyCompanyId).run()).meta.last_row_id);
  for(let i=0;i<2;i++) legacyBookingId=Number((await db.prepare("INSERT INTO bookings(company_id,barber_id,service_id,code,starts_at,ends_at,price_cents,status,customer_name,customer_phone,cancel_token) VALUES (?1,?2,?3,?4,'2026-12-01T12:00:00Z','2026-12-01T12:15:00Z',1000,'pendente','Cliente','5573999990000','private')").bind(legacyCompanyId,barber,service,`legacy-${i}`).run()).meta.last_row_id);
  for(const sql of guard.match(/CREATE TRIGGER[\s\S]+?END;/g)!) await db.prepare(sql).run();
});
async function fixture(){
  const slug=`booking-overlap-${crypto.randomUUID()}`;
  const companyId=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Bloqueios')").bind(slug).run()).meta.last_row_id);
  const barberId=Number((await db.prepare("INSERT INTO barbers(company_id,slug,name) VALUES (?1,'barber','Profissional')").bind(companyId).run()).meta.last_row_id);
  await db.prepare("INSERT INTO subscriptions(company_id,plan_code,status,period_end) VALUES (?1,'free','active',?2)").bind(companyId,new Date(Date.now()+86400000).toISOString()).run();
  const settings={...DEFAULT_SETTINGS};
  await db.prepare("INSERT INTO company_settings(company_id,data) VALUES (?1,?2)").bind(companyId,JSON.stringify(settings)).run();
  async function cookie(role:"owner"|"barber"){
    const userId=Number((await db.prepare("INSERT INTO users(name,email,password_hash) VALUES ('Pessoa',?1,'unused')").bind(`${crypto.randomUUID()}@tigu.test`).run()).meta.last_row_id);
    await db.prepare("INSERT INTO company_memberships(company_id,user_id,role,barber_id) VALUES (?1,?2,?3,?4)").bind(companyId,userId,role,role==="barber"?barberId:null).run();
    const token=crypto.randomUUID();
    await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,?3)").bind(await sha256hex(`${token}:${e.SESSION_SECRET}:${userId}`),userId,new Date(Date.now()+86400000).toISOString()).run();
    return `aurum_session=uid.${userId}.${token}`;
  }
  const staff=await cookie("barber"),owner=await cookie("owner");
  const request=(path:string,body:object,admin=false)=>app.request(`/api/c/${slug}/${admin?"admin":"painel"}${path}`,{
    method:"POST",headers:{"content-type":"application/json",cookie:admin?owner:staff},body:JSON.stringify(body),
  },e,ctx);
  const pending=()=>db.prepare("SELECT id FROM block_requests WHERE company_id=?1 ORDER BY id DESC LIMIT 1").bind(companyId).first<number>("id");
  return {companyId,barberId,settings,request,pending};
}
async function setup(){
  const f=await fixture();
  await db.prepare("UPDATE barbers SET work_days='[0,1,2,3,4,5,6]',work_start='09:00',work_end='18:00',break_start='00:00',break_end='00:00' WHERE id=?1").bind(f.barberId).run();
  const service=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',1000,11)").bind(f.companyId).run()).meta.last_row_id);
  await db.prepare("INSERT INTO service_barbers(service_id,barber_id) VALUES (?1,?2)").bind(service,f.barberId).run();
  const settings={...f.settings,min_lead_min:0,slot_step_min:7,whatsapp_reminders_enabled:false,whatsapp_confirm_enabled:false,opening_hours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[String(d),{open:"09:00",close:"18:00"}]))};
  const iso=(min:number)=>localToUtc("America/Bahia",day,min).toISOString().replace(/\.\d{3}Z$/,"Z");
  const raw=async(start:number,end:number,status="pendente")=>Number((await db.prepare("INSERT INTO bookings(company_id,barber_id,service_id,code,starts_at,ends_at,price_cents,status,customer_name,customer_phone,cancel_token) VALUES (?1,?2,?3,?4,?5,?6,1000,?7,'Cliente','5573999990000','private')")
    .bind(f.companyId,f.barberId,service,crypto.randomUUID(),iso(start),iso(end),status).run()).meta.last_row_id);
  const book=(start:number,phone:string)=>createBooking({db,env:e,companyId:f.companyId,settings,origin:"cliente"},{barberId:f.barberId,serviceId:service,startsAt:iso(start),name:"Cliente",phone,consent:true,whatsappOptin:false,idempotencyKey:crypto.randomUUID()});
  return {...f,service,iso,raw,book};
}
describe("reserva atômica de intervalos fora da mesma grade",()=>{
  it("banco recusa inserções concorrentes sobrepostas mesmo sem booking_slots",async()=>{
    const f=await setup();
    const results=await Promise.allSettled([f.raw(540,551),f.raw(547,558)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);
    const failed=results.find(r=>r.status==="rejected") as PromiseRejectedResult;
    expect(String(failed.reason)).toContain("TIGU_BOOKING_OVERLAP");
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(f.companyId).first("n")).toBe(1);
  });
  it("duas reservas públicas na grade de sete minutos não ocupam o mesmo intervalo",async()=>{
    const f=await setup();
    const results=await Promise.all([f.book(540,"5573999990001"),f.book(547,"5573999990002")]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(results.find(r=>!r.ok)).toMatchObject({ok:false,status:409});
    expect(await db.prepare("SELECT count(*) n FROM customers WHERE company_id=?1").bind(f.companyId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(f.companyId).first("n")).toBe(1);
  });
  it("bloqueio administrativo e reserva pública concorrem pelo intervalo real",async()=>{
    const f=await setup();
    const results=await Promise.all([f.book(540,"5573999990003"),createAdminIntervalBlock(db,f.companyId,"America/Bahia",{date:day,barberId:f.barberId,startMin:542,endMin:548,reason:"Indisponível"})]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(results.find(r=>!r.ok)).toMatchObject({ok:false,status:409});
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(f.companyId).first("n")).toBe(1);
  });
  it("remarcação conflitante reverte a transação inteira sem alterar o atendimento",async()=>{
    const f=await setup();
    await f.raw(540,551);
    const id=await f.raw(570,581);
    await expect(db.batch([
      db.prepare("UPDATE bookings SET customer_name='Não deve gravar' WHERE id=?1").bind(id),
      db.prepare("UPDATE bookings SET starts_at=?1,ends_at=?2 WHERE id=?3").bind(f.iso(547),f.iso(558),id),
    ])).rejects.toThrow(/TIGU_BOOKING_OVERLAP/);
    expect(await db.prepare("SELECT customer_name,starts_at,ends_at FROM bookings WHERE id=?1").bind(id).first()).toEqual({customer_name:"Cliente",starts_at:f.iso(570),ends_at:f.iso(581)});
  });
  it("permite intervalos adjacentes, status encerrado e outro profissional",async()=>{
    const a=await setup(),b=await setup();
    await a.raw(540,551);
    await a.raw(551,562);
    await a.raw(540,551,"cancelado");
    await b.raw(540,551);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(a.companyId).first("n")).toBe(3);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(b.companyId).first("n")).toBe(1);
  });
  it("trata timestamps equivalentes com milissegundos como o mesmo intervalo",async()=>{
    const f=await setup();
    const id=await f.raw(540,551);
    await db.prepare("UPDATE bookings SET starts_at=?1,ends_at=?2 WHERE id=?3").bind(f.iso(540).replace("Z",".000Z"),f.iso(551).replace("Z",".000Z"),id).run();
    await expect(f.raw(547,558)).rejects.toThrow(/TIGU_BOOKING_OVERLAP/);
  });
  it("não reativa reserva cancelada quando o intervalo já está ocupado",async()=>{
    const f=await setup();
    await f.raw(540,551);
    const id=await f.raw(540,551,"cancelado");
    await expect(db.prepare("UPDATE bookings SET status='confirmado' WHERE id=?1").bind(id).run()).rejects.toThrow(/TIGU_BOOKING_OVERLAP/);
    expect(await db.prepare("SELECT status FROM bookings WHERE id=?1").bind(id).first("status")).toBe("cancelado");
  });
  it("preserva dados legados e responde 409 ao confirmar um conflito já existente",async()=>{
    const result=await setBookingStatus({db,env:e,companyId:legacyCompanyId,settings:DEFAULT_SETTINGS,origin:"admin"},legacyBookingId,"confirmado");
    expect(result).toMatchObject({ok:false,status:409});
    expect(await db.prepare("SELECT status FROM bookings WHERE id=?1").bind(legacyBookingId).first("status")).toBe("pendente");
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(legacyCompanyId).first("n")).toBe(2);
    expect(await db.prepare("SELECT count(*) n FROM notifications WHERE company_id=?1").bind(legacyCompanyId).first("n")).toBe(0);
  });
});
