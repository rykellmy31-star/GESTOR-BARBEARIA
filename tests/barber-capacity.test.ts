/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema1 from "../migrations/0001_init.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"barber-capacity-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeAll(async()=>{
  for(const sql of schema1.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function fixture(limit=1){
  const slug=`capacity-${crypto.randomUUID()}`,plan=`plan-${crypto.randomUUID()}`;
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
describe("limites de profissionais do plano",()=>{
  it("criação concorrente não ocupa a última vaga duas vezes",async()=>{
    const f=await fixture();
    const results=await Promise.all([f.create("Primeiro"),f.create("Segundo")]);
    expect(results.map(r=>r.status).sort()).toEqual([200,402]);
    expect(await f.count()).toBe(1);
    const other=await fixture();
    expect((await other.create("Outra empresa")).status).toBe(200);
  });
  it("permite cadastro inativo, mas não reativa acima do limite nem muda campos junto",async()=>{
    const f=await fixture();
    expect((await f.create("Ativo")).status).toBe(200);
    const inactive=await f.create("Inativo",false);
    expect(inactive.status).toBe(200);
    const {id}=await inactive.json() as {id:number};
    expect((await f.request(`/barbers/${id}`,{active:true,name:"Não deve mudar"},"PUT")).status).toBe(402);
    expect(await db.prepare("SELECT name,active FROM barbers WHERE id=?1").bind(id).first()).toEqual({name:"Inativo",active:0});
  });
  it("duas reativações simultâneas disputam a mesma vaga no banco",async()=>{
    const f=await fixture();
    const a=await (await f.create("Inativo A",false)).json() as {id:number};
    const b=await (await f.create("Inativo B",false)).json() as {id:number};
    const responses=await Promise.all([a,b].map(x=>f.request(`/barbers/${x.id}`,{active:true},"PUT")));
    expect(responses.map(r=>r.status).sort()).toEqual([200,402]);
    expect(await f.count()).toBe(1);
  });
  it("respeita plano sem vagas e preserva plano ilimitado",async()=>{
    const zero=await fixture(0);
    expect((await zero.create("Sem vaga")).status).toBe(402);
    expect((await zero.create("Rascunho",false)).status).toBe(200);
    const unlimited=await fixture(-1);
    expect((await unlimited.create("Ilimitado A")).status).toBe(200);
    expect((await unlimited.create("Ilimitado B")).status).toBe(200);
    expect(await unlimited.count()).toBe(2);
  });
});
