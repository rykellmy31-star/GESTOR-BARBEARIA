/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema1 from "../migrations/0001_init.sql";
import schema6 from "../migrations/0006_request_rate_limits.sql";
const schema = schema1 + "\n" + schema6;
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import type { Env } from "../api/types";

const db = env.DB as D1Database;
const e = {...env,APP_ENV:"development",SESSION_SECRET:"team-isolation-test-secret-32-chars"} as Env;
const ctx = {waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeAll(async () => {
  for (const sql of schema.replace(/--[^\n]*/g, "").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function user(role="user") {
  const email = `team-${crypto.randomUUID()}@tigu.test`;
  const r = await db.prepare("INSERT INTO users (name,email,password_hash,platform_role) VALUES ('Pessoa',?1,'original-password-hash',?2)").bind(email,role).run();
  return {id:Number(r.meta.last_row_id),email};
}
async function company() {
  const owner = await user(),slug = `team-${crypto.randomUUID()}`;
  const c = await db.prepare("INSERT INTO companies (slug,name) VALUES (?1,'Equipe')").bind(slug).run();
  const id = Number(c.meta.last_row_id);
  await db.batch([
    db.prepare("INSERT INTO company_memberships (company_id,user_id,role) VALUES (?1,?2,'owner')").bind(id,owner.id),
    db.prepare("INSERT INTO subscriptions (company_id,plan_code,status,period_end) VALUES (?1,'free','active',?2)").bind(id,new Date(Date.now()+86400000).toISOString()),
  ]);
  const barber = await db.prepare("INSERT INTO barbers (company_id,slug,name) VALUES (?1,'staff','Profissional')").bind(id).run();
  const token = crypto.randomUUID();
  await db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?1,?2,?3)")
    .bind(await sha256hex(`${token}:${e.SESSION_SECRET}:${owner.id}`),owner.id,new Date(Date.now()+86400000).toISOString()).run();
  const cookie = `aurum_session=uid.${owner.id}.${token}`;
  const request = (path:string,body:object,method="POST") => app.request(`/api/c/${slug}/admin${path}`,{
    method,headers:{"content-type":"application/json",cookie},body:JSON.stringify(body),
  },e,ctx);
  return {id,owner,request,barberId:Number(barber.meta.last_row_id)};
}
describe("equipe: proteção da identidade global", () => {
  it("conhecer e-mail de Superadmin não permite vinculá-lo nem redefinir sua senha", async () => {
    const a = await company(),target = await user("superadmin");
    expect((await a.request("/team",{name:"Alvo",email:target.email,password:"AtaqueSenha#2026",role:"manager"})).status).toBe(409);
    expect((await a.request(`/barbers/${a.barberId}/credentials`,{email:target.email,password:"AtaqueSenha#2026"})).status).toBe(409);
    expect(await db.prepare("SELECT count(*) n FROM company_memberships WHERE user_id=?1").bind(target.id).first("n")).toBe(0);
    // Também protege vínculos legados criados antes desta correção.
    const membership = await db.prepare("INSERT INTO company_memberships (company_id,user_id,role) VALUES (?1,?2,'manager')").bind(a.id,target.id).run();
    expect((await a.request(`/team/${membership.meta.last_row_id}`,{reset_password:"AtaqueSenha#2026"},"PUT")).status).toBe(403);
    expect(await db.prepare("SELECT password_hash FROM users WHERE id=?1").bind(target.id).first("password_hash")).toBe("original-password-hash");
  });
  it("não redefine conta que participa de outra barbearia nem rebaixa o dono para barbeiro", async () => {
    const a = await company(),b = await company();
    const membership = await db.prepare("INSERT INTO company_memberships (company_id,user_id,role) VALUES (?1,?2,'manager')").bind(a.id,b.owner.id).run();
    expect((await a.request(`/team/${membership.meta.last_row_id}`,{reset_password:"AtaqueSenha#2026"},"PUT")).status).toBe(403);
    expect((await a.request(`/barbers/${a.barberId}/credentials`,{email:a.owner.email})).status).toBe(409);
    expect(await db.prepare("SELECT role FROM company_memberships WHERE company_id=?1 AND user_id=?2").bind(a.id,a.owner.id).first("role")).toBe("owner");
    expect(await db.prepare("SELECT password_hash FROM users WHERE id=?1").bind(b.owner.id).first("password_hash")).toBe("original-password-hash");
  });
  it("rejeita profissional de outra empresa antes de criar conta", async () => {
    const a = await company(),b = await company(),email = `foreign-${crypto.randomUUID()}@tigu.test`;
    expect((await a.request("/team",{name:"Equipe",email,password:"Provisoria#2026",role:"barber",barber_id:b.barberId})).status).toBe(400);
    expect(await db.prepare("SELECT id FROM users WHERE email=?1").bind(email).first()).toBeNull();
  });
  it("cria acesso novo com senha aleatória forte e troca obrigatória", async () => {
    const a = await company(),email = `new-${crypto.randomUUID()}@tigu.test`;
    const response = await a.request(`/barbers/${a.barberId}/credentials`,{email});
    expect(response.status).toBe(201);
    const body = await response.json() as {password:string};
    expect(body.password).toMatch(/^Tigu![a-f0-9]{32}$/);
    expect(await db.prepare("SELECT must_change_password FROM users WHERE email=?1").bind(email).first("must_change_password")).toBe(1);
  });
  it("reset de funcionário exclusivo revoga sessões e códigos antigos", async () => {
    const a = await company(),target = await user();
    const membership = await db.prepare("INSERT INTO company_memberships (company_id,user_id,role) VALUES (?1,?2,'barber')").bind(a.id,target.id).run();
    await db.batch([
      db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?1,?2,?3)").bind(crypto.randomUUID(),target.id,new Date(Date.now()+86400000).toISOString()),
      db.prepare("INSERT INTO password_resets (user_id,code_hash,expires_at) VALUES (?1,'old-code',?2)").bind(target.id,new Date(Date.now()+86400000).toISOString()),
    ]);
    expect((await a.request(`/team/${membership.meta.last_row_id}`,{reset_password:"ProvisoriaNova#2026"},"PUT")).status).toBe(200);
    expect(await db.prepare("SELECT must_change_password FROM users WHERE id=?1").bind(target.id).first("must_change_password")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?1").bind(target.id).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM password_resets WHERE user_id=?1 AND used_at IS NULL").bind(target.id).first("n")).toBe(0);
  });
});

describe("equipe: reativação e vínculo obrigatório", () => {
  it("reativa vínculo removido sem trocar senha ou promover papel", async () => {
    const a = await company(), target = await user();
    const membership = await db.prepare("INSERT INTO company_memberships(company_id,user_id,role,barber_id,active) VALUES (?1,?2,'barber',?3,0)").bind(a.id,target.id,a.barberId).run();
    expect((await a.request(`/team/${membership.meta.last_row_id}`,{active:true},"PUT")).status).toBe(200);
    expect(await db.prepare("SELECT active,role,barber_id FROM company_memberships WHERE id=?1").bind(membership.meta.last_row_id).first()).toEqual({active:1,role:"barber",barber_id:a.barberId});
    expect(await db.prepare("SELECT password_hash FROM users WHERE id=?1").bind(target.id).first("password_hash")).toBe("original-password-hash");
  });
  it("não ativa conta global desativada nem libera profissional sem vínculo", async () => {
    const a = await company(), target = await user();
    const membership = await db.prepare("INSERT INTO company_memberships(company_id,user_id,role,barber_id,active) VALUES (?1,?2,'barber',?3,0)").bind(a.id,target.id,a.barberId).run();
    await db.prepare("UPDATE users SET active=0 WHERE id=?1").bind(target.id).run();
    expect((await a.request(`/team/${membership.meta.last_row_id}`,{active:true},"PUT")).status).toBe(409);
    expect((await a.request(`/team/${membership.meta.last_row_id}`,{barber_id:null},"PUT")).status).toBe(422);
    expect(await db.prepare("SELECT active,barber_id FROM company_memberships WHERE id=?1").bind(membership.meta.last_row_id).first()).toEqual({active:0,barber_id:a.barberId});
  });
});
