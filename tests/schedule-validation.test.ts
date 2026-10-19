/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema1 from "../migrations/0001_init.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import { DEFAULT_SETTINGS, companySettingsSchema } from "../api/lib/settings";
import { barberScheduleSchema } from "../api/lib/schedule-validation";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"barber-schedule-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeAll(async()=>{
  for(const sql of schema1.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function fixture(limit=1){
  const slug=`schedule-${crypto.randomUUID()}`,plan=`plan-${crypto.randomUUID()}`;
  await db.prepare("INSERT INTO plans(code,name,price_cents_month,max_barbers) VALUES (?1,'Teste de limite',1999,?2)").bind(plan,limit).run();
  const id=Number((await db.prepare("INSERT INTO companies(slug,name,plan_code) VALUES (?1,'Equipe limitada',?2)").bind(slug,plan).run()).meta.last_row_id);
  const uid=Number((await db.prepare("INSERT INTO users(name,email,password_hash) VALUES ('Dono',?1,'unused')").bind(`${slug}@tigu.test`).run()).meta.last_row_id);
  await db.batch([
    db.prepare("INSERT INTO subscriptions(company_id,plan_code,status,period_end) VALUES (?1,?2,'active',?3)").bind(id,plan,new Date(Date.now()+86400000).toISOString()),
    db.prepare("INSERT INTO company_memberships(company_id,user_id,role) VALUES (?1,?2,'owner')").bind(id,uid),
  ]);
  const token=crypto.randomUUID();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,?3)").bind(await sha256hex(`${token}:${e.SESSION_SECRET}:${uid}`),uid,new Date(Date.now()+86400000).toISOString()).run();
  const request=(path:string,body:object,method="POST")=>app.request(`/api/c/${slug}/admin${path}`,{method,headers:{"content-type":"application/json",cookie:`aurum_session=uid.${uid}.${token}`},body:JSON.stringify(body)},e,ctx);
  const create=(name:string,active=true)=>request("/barbers",{name,active,work_days:[1,2,3,4,5],work_start:"09:00",work_end:"18:00",break_start:"12:00",break_end:"13:00",service_ids:[]});
  const count=()=>db.prepare("SELECT count(*) n FROM barbers WHERE company_id=?1 AND active=1").bind(id).first("n");
  return {id,request,create,count};
}
const schedule={work_days:[1,2,3,4,5],work_start:"09:00",work_end:"18:00",break_start:"12:00",break_end:"13:00"};
describe("validação da configuração de agenda",()=>{
  it("aceita fusos reais e rejeita fusos que fariam Intl lançar erro",()=>{
    for(const timezone of ["America/Bahia","America/Manaus","UTC"])
      expect(companySettingsSchema.safeParse({...DEFAULT_SETTINGS,timezone}).success).toBe(true);
    expect(companySettingsSchema.safeParse({...DEFAULT_SETTINGS,timezone:"America/Inexistente"}).success).toBe(false);
  });
  it("recusa horas inexistentes, dias inválidos e fechamento antes ou igual à abertura",()=>{
    for(const range of [{open:"25:00",close:"26:00"},{open:"09:60",close:"18:00"},{open:"18:00",close:"09:00"},{open:"09:00",close:"09:00"}])
      expect(companySettingsSchema.safeParse({...DEFAULT_SETTINGS,opening_hours:{"1":range}}).success).toBe(false);
    expect(companySettingsSchema.safeParse({...DEFAULT_SETTINGS,opening_hours:{"7":null}}).success).toBe(false);
    expect(companySettingsSchema.safeParse({...DEFAULT_SETTINGS,opening_hours:{"0":null,"1":{open:"09:05",close:"18:25"}}}).success).toBe(true);
  });
  it("valida ordem do expediente, dias duplicados e pausa; permite ausência de pausa",()=>{
    for(const patch of [{work_days:[1,1]},{work_start:"19:00"},{work_end:"25:00"},{break_start:"14:00",break_end:"13:00"},{break_start:"08:00"},{break_end:"19:00"}])
      expect(barberScheduleSchema.safeParse({...schedule,...patch}).success).toBe(false);
    expect(barberScheduleSchema.safeParse({...schedule,break_start:"00:00",break_end:"00:00"}).success).toBe(true);
  });
  it("API rejeita configurações inválidas sem substituir as configurações salvas",async()=>{
    const f=await fixture();
    const settings={...DEFAULT_SETTINGS,shop_name:"Configuração preservada",timezone:"America/Manaus"};
    expect((await f.request("/settings",settings,"PUT")).status).toBe(200);
    for(const patch of [{timezone:"America/Inexistente"},{opening_hours:{"1":{open:"20:00",close:"09:00"}}}])
      expect((await f.request("/settings",{...settings,...patch},"PUT")).status).toBe(422);
    expect(JSON.parse((await db.prepare("SELECT data FROM company_settings WHERE company_id=?1").bind(f.id).first<string>("data"))!)).toMatchObject({shop_name:settings.shop_name,timezone:settings.timezone});
  });
  it("valida edição parcial contra o expediente salvo sem alterar campos quando rejeitada",async()=>{
    const f=await fixture();
    const created=await f.create("Profissional válido");
    expect(created.status).toBe(200);
    const {id}=await created.json() as {id:number};
    expect((await f.request(`/barbers/${id}`,{name:"Não deve gravar",work_end:"10:00"},"PUT")).status).toBe(422);
    expect(await db.prepare("SELECT name,work_end FROM barbers WHERE id=?1").bind(id).first()).toEqual({name:"Profissional válido",work_end:"18:00"});
    expect((await f.request(`/barbers/${id}`,{work_start:"13:00",break_start:"00:00",break_end:"00:00"},"PUT")).status).toBe(200);
  });
  it("rejeita criação inválida antes de ocupar vaga no plano",async()=>{
    const f=await fixture();
    expect((await f.request("/barbers",{name:"Inválido",...schedule,work_start:"23:00"})).status).toBe(422);
    expect(await f.count()).toBe(0);
    expect((await f.create("Correto")).status).toBe(200);
  });
});
