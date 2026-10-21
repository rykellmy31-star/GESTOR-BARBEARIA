/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { app } from "../api/index";
import { sha256hex,verifyPassword } from "../api/lib/crypto";
import { canOperateSubscription,type SubscriptionAccess } from "../api/lib/trial";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"super-onboarding-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeAll(async()=>{
  for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function user(role="user"){
  const email=`super-onboarding-${crypto.randomUUID()}@tigu.test`;
  const id=Number((await db.prepare("INSERT INTO users(name,email,password_hash,platform_role) VALUES ('Pessoa',?1,'original-hash',?2)").bind(email,role).run()).meta.last_row_id);
  const token=crypto.randomUUID();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,?3)").bind(await sha256hex(`${token}:${e.SESSION_SECRET}:${id}`),id,new Date(Date.now()+86400000).toISOString()).run();
  return {id,email,cookie:`aurum_session=uid.${id}.${token}`};
}
async function admin(){
  const u=await user("superadmin");
  return (path:string,body:object,method="POST")=>app.request(`/api/super${path}`,{method,headers:{"content-type":"application/json",cookie:u.cookie},...(method==="GET"?{}:{body:JSON.stringify(body)})},e,ctx);
}
function input(){
  return {name:"Barbearia assistida",slug:`assisted-${crypto.randomUUID()}`,plan_code:"pro",owner_name:"Novo dono",owner_email:`new-owner-${crypto.randomUUID()}@tigu.test`};
}
describe("Superadmin: cadastro assistido seguro",()=>{
  it("cria conta completa, senha utilizável e teste de 15 dias sem ativar assinatura paga",async()=>{
    const request=await admin(),payload=input(),response=await request("/companies",payload);
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const result=await response.json() as {id:number;owner_user_id:number;created_user:boolean;generated_password:string;trial_end:string};
    expect(result.created_user).toBe(true);
    expect(result.generated_password).toMatch(/^Tigu![a-f0-9]{32}$/);
    const owner=await db.prepare("SELECT password_hash,must_change_password FROM users WHERE id=?1").bind(result.owner_user_id).first<{password_hash:string;must_change_password:number}>();
    expect(await verifyPassword(result.generated_password,owner!.password_hash)).toBe(true);
    expect(owner?.must_change_password).toBe(1);
    const sub=await db.prepare("SELECT plan_code,status,started_at,period_end FROM subscriptions WHERE company_id=?1").bind(result.id).first<SubscriptionAccess&{started_at:string}>();
    expect(sub?.status).toBe("trial");
    expect(sub?.plan_code).toBe("pro");
    expect(Date.parse(sub!.period_end!)-Date.parse(sub!.started_at)).toBe(15*86400000);
    expect(canOperateSubscription(sub)).toBe(true);
    expect(result.trial_end).toBe(sub?.period_end);
    expect(await db.prepare("SELECT balance_cents FROM wallets WHERE company_id=?1").bind(result.id).first("balance_cents")).toBe(0);
    expect(await db.prepare("SELECT role FROM company_memberships WHERE company_id=?1 AND user_id=?2").bind(result.id,result.owner_user_id).first("role")).toBe("owner");
  });
  it("falha em uma etapa reverte também usuário e empresa",async()=>{
    const request=await admin(),payload=input(),trigger=`fail_wallet_${crypto.randomUUID().replace(/-/g,"")}`;
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON wallets
      WHEN NEW.company_id IN(SELECT id FROM companies WHERE slug='${payload.slug}')
      BEGIN SELECT RAISE(ABORT,'test onboarding rollback'); END`).run();
    try {
      expect((await request("/companies",payload)).status).toBe(503);
      expect(await db.prepare("SELECT id FROM users WHERE email=?1").bind(payload.owner_email).first()).toBeNull();
      expect(await db.prepare("SELECT id FROM companies WHERE slug=?1").bind(payload.slug).first()).toBeNull();
    } finally {await db.prepare(`DROP TRIGGER ${trigger}`).run();}
  });
  it("conta existente mantém sua senha e não recebe senha automática ou troca obrigatória",async()=>{
    const request=await admin(),existing=await user(),payload={...input(),owner_email:existing.email,owner_password:"NaoPodeSubstituir#2026"};
    const response=await request("/companies",payload);
    expect(response.status).toBe(201);
    const result=await response.json() as {created_user:boolean;generated_password?:string;owner_user_id:number};
    expect(result).toMatchObject({created_user:false,owner_user_id:existing.id});
    expect(result.generated_password).toBeUndefined();
    expect(await db.prepare("SELECT password_hash,must_change_password FROM users WHERE id=?1").bind(existing.id).first()).toEqual({password_hash:"original-hash",must_change_password:0});
    await db.prepare("UPDATE users SET active=0 WHERE id=?1").bind(existing.id).run();
    expect((await request("/companies",{...input(),owner_email:existing.email})).status).toBe(409);
  });
  it("senha informada é provisória e não retorna no HTTP",async()=>{
    const request=await admin(),payload={...input(),owner_password:"SenhaInicial#2026"};
    const response=await request("/companies",payload);
    expect(response.status).toBe(201);
    const result=await response.json() as {owner_user_id:number;generated_password?:string};
    expect(result.generated_password).toBeUndefined();
    const row=await db.prepare("SELECT password_hash,must_change_password FROM users WHERE id=?1").bind(result.owner_user_id).first<{password_hash:string;must_change_password:number}>();
    expect(await verifyPassword(payload.owner_password,row!.password_hash)).toBe(true);
    expect(row?.must_change_password).toBe(1);
  });
  it("reset do suporte e desativação revogam sessões e códigos antigos",async()=>{
    const request=await admin(),target=await user();
    await db.prepare("INSERT INTO password_resets(user_id,code_hash,expires_at) VALUES (?1,'old-code',?2)").bind(target.id,new Date(Date.now()+86400000).toISOString()).run();
    expect((await request(`/users/${target.id}`,{reset_password:"NovaSenhaSuporte#2026"},"PUT")).status).toBe(200);
    expect(await db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?1").bind(target.id).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM password_resets WHERE user_id=?1 AND used_at IS NULL").bind(target.id).first("n")).toBe(0);
    const another=await user();
    await db.prepare("INSERT INTO password_resets(user_id,code_hash,expires_at) VALUES (?1,'old-code',?2)").bind(another.id,new Date(Date.now()+86400000).toISOString()).run();
    expect((await request(`/users/${another.id}`,{active:false},"PUT")).status).toBe(200);
    expect(await db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?1").bind(another.id).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM password_resets WHERE user_id=?1 AND used_at IS NULL").bind(another.id).first("n")).toBe(0);
  });
  it("usuário comum não pode criar empresa pelo Superadmin nem receber credenciais",async()=>{
    const actor=await user();
    const response=await app.request("/api/super/companies",{method:"POST",headers:{"content-type":"application/json",cookie:actor.cookie},body:JSON.stringify(input())},e,ctx);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("generated_password");
  });
});


describe("Superadmin: companyId nas rotas financeiras",()=>{
  it("consulta e atualiza carteira e política sem confundir companyId com id",async()=>{
    const request=await admin();
    const created=await request("/companies",input());
    expect(created.status).toBe(201);
    const payload=await created.json() as {id:number};
    const route="/wallets/"+payload.id;
    const initial=await request(route,{},"GET");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({wallet:{company_id:payload.id,balance_cents:0}});
    const credit=await request(route+"/adjust",{delta_cents:1250,justification:"Crédito fictício testado"});
    expect(credit.status).toBe(200);
    const policy=await request(route+"/policy",{allow_negative:true},"PUT");
    expect(policy.status).toBe(200);
    const latest=await request(route,{},"GET");
    expect(latest.status).toBe(200);
    const body=await latest.json() as {wallet:{company_id:number;balance_cents:number;allow_negative:number};transactions:{amount_cents:number}[]};
    expect(body.wallet).toMatchObject({company_id:payload.id,balance_cents:1250,allow_negative:1});
    expect(body.transactions.filter(row=>row.amount_cents===1250)).toHaveLength(1);
  });
  it("não modifica nem consulta carteira com id inválido ou empresa inexistente",async()=>{
    const request=await admin();
    expect((await request("/wallets/abc",{},"GET")).status).toBe(400);
    expect((await request("/wallets/0/adjust",{delta_cents:1250,justification:"Motivo válido de teste"})).status).toBe(400);
    expect((await request("/wallets/12x/policy",{allow_negative:true},"PUT")).status).toBe(400);
    expect((await request("/wallets/999999999",{},"GET")).status).toBe(404);
    expect((await request("/wallets/999999999/adjust",{delta_cents:1250,justification:"Motivo válido de teste"})).status).toBe(404);
    expect((await request("/wallets/999999999/policy",{allow_negative:true},"PUT")).status).toBe(404);
  });
});
