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
const e={...env,APP_ENV:"development",SESSION_SECRET:"admin-day-block-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
beforeAll(async()=>{
  for(const schema of [schema1,schema6]) for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function fixture(){
  const slug=`admin-day-block-${crypto.randomUUID()}`;
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
describe("folgas e férias: datas e escopo",()=>{
  it.each(["camel","snake","date"])("aceita formato %s e usa o dia inicial como fim quando omitido",async style=>{
    const f=await fixture();
    const body=style==="camel"?{barberId:f.barberId,dateFrom:day}:style==="snake"?{barber_id:f.barberId,date_from:day}:{barberId:f.barberId,date:day};
    expect((await f.request("/blocked-days",body,true)).status).toBe(201);
    expect(await db.prepare("SELECT barber_id,date_from,date_to FROM blocked_days WHERE company_id=?1").bind(f.companyId).first()).toEqual({barber_id:f.barberId,date_from:day,date_to:day});
  });
  it("rejeita datas inexistentes, período invertido e aliases contraditórios sem gravar",async()=>{
    const f=await fixture(),next=new Date(Date.parse(`${day}T12:00:00Z`)+86400000).toISOString().slice(0,10);
    const invalid=[{dateFrom:"2026-02-30"},{dateFrom:day,dateTo:"2026-02-30"},{dateFrom:next,dateTo:day},{dateFrom:day,date_from:next},{dateFrom:day,dateTo:day,date_to:next},{dateFrom:day,barberId:f.barberId,barber_id:null},{}];
    for(const body of invalid) expect((await f.request("/blocked-days",body,true)).status).toBe(422);
    expect(await db.prepare("SELECT count(*) n FROM blocked_days WHERE company_id=?1").bind(f.companyId).first("n")).toBe(0);
  });
  it("alias antigo também exige ordem das datas e profissional da empresa",async()=>{
    const a=await fixture(),b=await fixture();
    expect((await a.request("/bookings/block",{day,barberId:b.barberId},true)).status).toBe(404);
    expect((await a.request("/blocked-days",{date:day,barberId:b.barberId},true)).status).toBe(404);
    expect((await a.request("/bookings/block",{day:"2026-02-30"},true)).status).toBe(400);
    expect((await a.request("/bookings/block",{day:"2026-11-02",endDay:"2026-11-01"},true)).status).toBe(422);
    expect(await db.prepare("SELECT count(*) n FROM blocked_days WHERE company_id=?1").bind(a.companyId).first("n")).toBe(0);
  });
  it("aceita ano bissexto e feriado geral sem vincular profissional",async()=>{
    const f=await fixture();
    expect((await f.request("/blocked-days",{dateFrom:"2028-02-29",dateTo:"2028-03-01",kind:"holiday",reason:"  Feriado geral  "},true)).status).toBe(201);
    expect(await db.prepare("SELECT barber_id,date_from,date_to,kind,reason FROM blocked_days WHERE company_id=?1").bind(f.companyId).first()).toEqual({barber_id:null,date_from:"2028-02-29",date_to:"2028-03-01",kind:"holiday",reason:"Feriado geral"});
  });
});
