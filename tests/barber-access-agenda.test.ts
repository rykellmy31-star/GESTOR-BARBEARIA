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
const e={...env,APP_ENV:"development",SESSION_SECRET:"barber-access-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
beforeAll(async()=>{
  for(const schema of [schema1,schema6]) for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function fixture(){
  const slug=`barber-access-${crypto.randomUUID()}`;
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
  const get=(path:string)=>app.request(`/api/c/${slug}/painel${path}`,{headers:{cookie:staff}},e,ctx);
  return {companyId,barberId,settings,request,pending,get};
}
describe("painel do profissional: acesso e dia local",()=>{
  it("desativação do profissional impede consulta e mutações com sessão já existente",async()=>{
    const f=await fixture();
    expect((await f.get("/me")).status).toBe(200);
    await db.prepare("UPDATE barbers SET active=0 WHERE id=?1").bind(f.barberId).run();
    for(const path of ["/me","/agenda","/notifications","/reviews","/block-requests"])
      expect((await f.get(path)).status).toBe(403);
    expect((await f.request("/block-requests",{date:day,reason:"Não deve gravar"})).status).toBe(403);
    expect(await f.pending()).toBeNull();
    await db.prepare("UPDATE barbers SET active=1 WHERE id=?1").bind(f.barberId).run();
    expect((await f.get("/me")).status).toBe(200);
  });
  it("vínculo legado estrangeiro ou sem profissional também é recusado",async()=>{
    const a=await fixture(),b=await fixture();
    for(const barberId of [b.barberId,null]){
      await db.prepare("UPDATE company_memberships SET barber_id=?1 WHERE company_id=?2 AND role='barber'").bind(barberId,a.companyId).run();
      expect((await a.get("/me")).status).toBe(403);
      expect((await a.get("/agenda")).status).toBe(403);
    }
  });
  it("desativar um profissional não bloqueia o proprietário nem outra empresa",async()=>{
    const a=await fixture(),b=await fixture();
    await db.prepare("UPDATE barbers SET active=0 WHERE id=?1").bind(a.barberId).run();
    expect((await a.request("/blocked-days",{date:day},true)).status).toBe(201);
    expect((await b.get("/me")).status).toBe(200);
  });
  it("rejeita datas e quantidades de dias inválidas com 400 em vez de erro interno",async()=>{
    const f=await fixture();
    for(const suffix of ["from=2026-02-30","from=texto","days=NaN","days=0","days=32","days=2.5","from=9999-12-31&days=31"])
      expect((await f.get(`/agenda?${suffix}`)).status).toBe(400);
  });
  it("inclui o final do dia local e exclui as bordas dos dias vizinhos",async()=>{
    const f=await fixture();
    const service=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',1000,15)").bind(f.companyId).run()).meta.last_row_id);
    const base=Date.parse(`${day}T12:00:00Z`),prev=new Date(base-86400000).toISOString().slice(0,10),next=new Date(base+86400000).toISOString().slice(0,10);
    const entries=[{date:prev,min:1410,name:"Dia anterior"},{date:day,min:15,name:"Começo local"},{date:day,min:1410,name:"Fim local"},{date:next,min:0,name:"Dia seguinte"}];
    for(const entry of entries){
      const start=localToUtc("America/Bahia",entry.date,entry.min);
      await db.prepare("INSERT INTO bookings(company_id,barber_id,service_id,code,starts_at,ends_at,price_cents,status,customer_name,customer_phone,cancel_token) VALUES (?1,?2,?3,?4,?5,?6,1000,'pendente',?7,'5573999990000','private')")
        .bind(f.companyId,f.barberId,service,crypto.randomUUID(),start.toISOString().replace(/\.\d{3}Z$/,"Z"),new Date(start.getTime()+15*60000).toISOString().replace(/\.\d{3}Z$/,"Z"),entry.name).run();
    }
    const response=await f.get(`/agenda?from=${day}&days=1`);
    expect(response.status).toBe(200);
    const result=await response.json() as {days:Record<string,{customer_name:string}[]>;bookings:{customer_name:string}[]};
    expect(result.bookings.map(b=>b.customer_name)).toEqual(["Começo local","Fim local"]);
    expect(Object.keys(result.days)).toEqual([day]);
  });
});
