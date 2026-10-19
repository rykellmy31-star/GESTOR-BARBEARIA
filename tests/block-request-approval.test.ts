/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema1 from "../migrations/0001_init.sql";
import schema6 from "../migrations/0006_request_rate_limits.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import { resolveBlockRequest } from "../api/lib/block-requests";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc } from "../api/lib/time";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"block-request-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
beforeAll(async()=>{
  for(const schema of [schema1,schema6]) for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function fixture(){
  const slug=`block-${crypto.randomUUID()}`;
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
describe("folgas e bloqueios: aprovação obrigatória",()=>{
  it.each(["/block-request","/block-requests"])("%s não aplica folga sem decisão do dono",async path=>{
    const f=await fixture();
    const response=await f.request(path,{day,date:day,reason:"Consulta médica"});
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({pending_approval:true});
    expect(await db.prepare("SELECT count(*) n FROM blocked_days WHERE company_id=?1").bind(f.companyId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(f.companyId).first("n")).toBe(0);
    const id=await f.pending();
    expect((await f.request(`/block-requests/${id}/resolve`,{approve:true},true)).status).toBe(200);
    expect(await db.prepare("SELECT count(*) n FROM booking_slots WHERE company_id=?1").bind(f.companyId).first("n")).toBe(288);
    expect((await f.request(`/block-requests/${id}/approve`,{},true)).status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1").bind(f.companyId).first("n")).toBe(1);
  });
  it("todos os aliases respeitam a permissão desativada e intervalos inválidos",async()=>{
    const f=await fixture();
    for(const path of ["/block-request","/block-requests"]){
      expect((await f.request(path,{date:day,startMin:600,endMin:590,reason:"Intervalo errado"})).status).toBe(400);
      expect((await f.request(path,{date:day,startMin:600,reason:"Intervalo incompleto"})).status).toBe(400);
    }
    await db.prepare("UPDATE company_settings SET data=?1 WHERE company_id=?2").bind(JSON.stringify({...f.settings,barber_can_block:false}),f.companyId).run();
    for(const path of ["/block-request","/block-requests"]) expect((await f.request(path,{date:day,reason:"Tentativa sem permissão"})).status).toBe(403);
    expect(await f.pending()).toBeNull();
  });
  it("aprovação usa o fuso local e bloqueia conflito em todos os aliases",async()=>{
    const f=await fixture();
    expect((await f.request("/block-requests",{date:day,startMin:600,endMin:660,reason:"Curso"})).status).toBe(201);
    const id=await f.pending();
    const start=localToUtc("America/Bahia",day,600).toISOString().replace(/\.\d{3}Z$/,"Z"),end=localToUtc("America/Bahia",day,660).toISOString().replace(/\.\d{3}Z$/,"Z");
    const serviceId=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',1999,60)").bind(f.companyId).run()).meta.last_row_id);
    await db.prepare("INSERT INTO bookings(company_id,barber_id,code,starts_at,ends_at,customer_name,customer_phone,status,origin,price_cents,service_id,cancel_token) VALUES (?1,?2,?3,?4,?5,'Cliente','5573999990000','pendente','cliente',1999,?6,?7)").bind(f.companyId,f.barberId,crypto.randomUUID(),start,end,serviceId,crypto.randomUUID()).run();
    expect((await f.request(`/block-requests/${id}/approve`,{},true)).status).toBe(409);
    expect((await f.request(`/block-requests/${id}/resolve`,{approve:true},true)).status).toBe(409);
    await db.prepare("UPDATE bookings SET status='cancelado' WHERE company_id=?1").bind(f.companyId).run();
    expect((await f.request(`/block-requests/${id}/approve`,{},true)).status).toBe(200);
    expect(await db.prepare("SELECT starts_at,ends_at FROM bookings WHERE company_id=?1 AND status='bloqueio'").bind(f.companyId).first()).toEqual({starts_at:start,ends_at:end});
  });
  it("duas aprovações concorrentes não duplicam bloqueios e outra empresa não resolve o pedido",async()=>{
    const a=await fixture(),b=await fixture();
    await a.request("/block-requests",{date:day,startMin:600,endMin:660,reason:"Compromisso"});
    const id=(await a.pending())!;
    expect((await resolveBlockRequest(db,b.companyId,id,true,"America/Bahia")).ok).toBe(false);
    const results=await Promise.all([resolveBlockRequest(db,a.companyId,id,true,"America/Bahia"),resolveBlockRequest(db,a.companyId,id,true,"America/Bahia")]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) n FROM bookings WHERE company_id=?1 AND status='bloqueio'").bind(a.companyId).first("n")).toBe(1);
  });
});
