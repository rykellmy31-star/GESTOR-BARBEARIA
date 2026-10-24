import { applyBookingMigrations } from "./helpers/booking-migrations";
/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema1 from "../migrations/0001_init.sql";
import schema6 from "../migrations/0006_request_rate_limits.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc } from "../api/lib/time";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"admin-block-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
beforeAll(async()=>{
  for(const schema of [schema1,schema6]) for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  await applyBookingMigrations(db);
});
async function fixture(){
  const slug=`admin-block-${crypto.randomUUID()}`;
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
const interval={date:day,day,startMin:600,endMin:660,reason:"Compromisso"};
describe("bloqueios diretos da administração",()=>{
  it.each(["/blocks","/bookings/block"])("%s cria bloqueio utilizável e retorna protocolo",async path=>{
    const f=await fixture();
    const response=await f.request(path,{...interval,barberId:f.barberId},true);
    expect(response.status).toBe(201);
    const body=await response.json() as {code:string};
    expect(body.code).toMatch(/^BLK-/);
    const saved=await db.prepare("SELECT starts_at,ends_at,notes FROM bookings WHERE company_id=?1 AND code=?2").bind(f.companyId,body.code).first();
    expect(saved).toEqual({starts_at:localToUtc("America/Bahia",day,600).toISOString().replace(/\.\d{3}Z$/,"Z"),ends_at:localToUtc("America/Bahia",day,660).toISOString().replace(/\.\d{3}Z$/,"Z"),notes:"Compromisso"});
    expect(await db.prepare("SELECT count(*) n FROM booking_slots WHERE company_id=?1").bind(f.companyId).first("n")).toBe(12);
  });
  it("todos os caminhos recusam profissional estrangeiro ou inativo sem bloquear a outra empresa",async()=>{
    const a=await fixture(),b=await fixture();
    for(const path of ["/blocks","/bookings/block"])
      expect((await a.request(path,{...interval,barberId:b.barberId},true)).status).toBe(404);
    expect(await db.prepare("SELECT count(*) n FROM booking_slots WHERE barber_id=?1").bind(b.barberId).first("n")).toBe(0);
    await db.prepare("UPDATE barbers SET active=0 WHERE id=?1").bind(a.barberId).run();
    for(const path of ["/blocks","/bookings/block"])
      expect((await a.request(path,{...interval,barberId:a.barberId},true)).status).toBe(404);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id IN(?1,?2)").bind(a.companyId,b.companyId).first("n")).toBe(0);
  });
  it("recusa datas inexistentes e intervalos invertidos ou vazios em ambos os caminhos",async()=>{
    const f=await fixture();
    for(const path of ["/blocks","/bookings/block"])
      for(const patch of [{day:"2026-02-30",date:"2026-02-30"},{endMin:600},{endMin:590}])
        expect((await f.request(path,{...interval,barberId:f.barberId,...patch},true)).status).toBe(400);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(f.companyId).first("n")).toBe(0);
  });
  it("alias antigo recusa intervalo incompleto ou em dois dias sem converter para folga",async()=>{
    const f=await fixture();
    for(const payload of [{day,startMin:600},{day,endMin:660},{...interval,endDay:new Date(Date.parse(`${day}T12:00:00Z`)+86400000).toISOString().slice(0,10)}])
      expect((await f.request("/bookings/block",{...payload,barberId:f.barberId},true)).status).toBe(400);
    expect(await db.prepare("SELECT count(*) n FROM blocked_days WHERE company_id=?1").bind(f.companyId).first("n")).toBe(0);
  });
  it("conflito com reserva sem slots também é recusado, preservando o atendimento",async()=>{
    const f=await fixture();
    const service=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',1999,60)").bind(f.companyId).run()).meta.last_row_id);
    await db.prepare("INSERT INTO bookings(company_id,barber_id,service_id,code,starts_at,ends_at,price_cents,status,customer_name,customer_phone,cancel_token) VALUES (?1,?2,?3,?4,?5,?6,1999,'pendente','Cliente','5573999990000','private')")
      .bind(f.companyId,f.barberId,service,crypto.randomUUID(),localToUtc("America/Bahia",day,600).toISOString().replace(/\.\d{3}Z$/,"Z"),localToUtc("America/Bahia",day,660).toISOString().replace(/\.\d{3}Z$/,"Z")).run();
    for(const path of ["/blocks","/bookings/block"])
      expect((await f.request(path,{...interval,barberId:f.barberId},true)).status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(f.companyId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM booking_slots WHERE company_id=?1").bind(f.companyId).first("n")).toBe(0);
  });
  it("dois caminhos concorrentes reservam o horário só uma vez",async()=>{
    const f=await fixture();
    const results=await Promise.all(["/blocks","/bookings/block"].map(path=>f.request(path,{...interval,barberId:f.barberId},true)));
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(f.companyId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM booking_slots WHERE company_id=?1").bind(f.companyId).first("n")).toBe(12);
  });
  it("suporta dia inteiro sem exceder tamanho de batch e mantém isolamento",async()=>{
    const f=await fixture(),other=await fixture();
    expect((await f.request("/blocks",{date:day,barberId:f.barberId,startMin:0,endMin:1440},true)).status).toBe(201);
    expect(await db.prepare("SELECT count(*) n FROM booking_slots WHERE company_id=?1").bind(f.companyId).first("n")).toBe(288);
    expect((await other.request("/blocks",{date:day,barberId:other.barberId,startMin:0,endMin:1440},true)).status).toBe(201);
  });
});
