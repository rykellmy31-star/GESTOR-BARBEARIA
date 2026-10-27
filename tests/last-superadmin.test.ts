/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import guard from "../migrations/0007_last_superadmin_guard.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"super-guard-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeAll(async()=>{
  for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  for(const sql of guard.match(/CREATE TRIGGER[\s\S]+?END;/g)!) await db.prepare(sql).run();
});
async function user(role="user"){
  const email=`super-guard-${crypto.randomUUID()}@tigu.test`;
  const id=Number((await db.prepare("INSERT INTO users(name,email,password_hash,platform_role) VALUES ('Pessoa',?1,'original-hash',?2)").bind(email,role).run()).meta.last_row_id);
  const token=crypto.randomUUID();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,?3)").bind(await sha256hex(`${token}:${e.SESSION_SECRET}:${id}`),id,new Date(Date.now()+86400000).toISOString()).run();
  return {id,email,cookie:`aurum_session=uid.${id}.${token}`};
}
async function fixture(count=1){
  const actors:Awaited<ReturnType<typeof user>>[]=[];
  for(let i=0;i<count;i++) actors.push(await user("superadmin"));
  // Mantém somente os Superadmins desta fixture no banco de teste compartilhado.
  await db.prepare(`UPDATE users SET platform_role='user' WHERE platform_role='superadmin' AND id NOT IN (${actors.map(a=>a.id).join(",")})`).run();
  const request=(actor:typeof actors[number],id:number,body:object,erase=false)=>app.request(`/api/super/users/${id}${erase?"/erase":""}`,{method:erase?"POST":"PUT",headers:{"content-type":"application/json",cookie:actor.cookie},body:JSON.stringify(body)},e,ctx);
  const activeCount=()=>db.prepare("SELECT count(*) n FROM users WHERE active=1 AND platform_role='superadmin'").first("n");
  return {actors,request,activeCount};
}
describe("preservação do último Superadmin",()=>{
  it("recusa desativação e rebaixamento da única conta sem alterar senha ou sessões",async()=>{
    const f=await fixture(),actor=f.actors[0];
    for(const change of [{active:false},{platform_role:"user"},{active:false,platform_role:"user",reset_password:"NaoDeveGravar#2026"}]){
      expect((await f.request(actor,actor.id,change)).status).toBe(409);
      expect(await db.prepare("SELECT active,platform_role,password_hash FROM users WHERE id=?1").bind(actor.id).first()).toEqual({active:1,platform_role:"superadmin",password_hash:"original-hash"});
      expect(await db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?1").bind(actor.id).first("n")).toBe(1);
    }
    expect(await f.activeCount()).toBe(1);
  });
  it("anonimização recusada reverte também vínculos, sessões e códigos de recuperação",async()=>{
    const f=await fixture(),actor=f.actors[0];
    const company=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Empresa')").bind(crypto.randomUUID()).run()).meta.last_row_id);
    await db.prepare("INSERT INTO company_memberships(company_id,user_id,role) VALUES (?1,?2,'owner')").bind(company,actor.id).run();
    await db.prepare("INSERT INTO password_resets(user_id,code_hash,expires_at) VALUES (?1,'preserve',?2)").bind(actor.id,new Date(Date.now()+86400000).toISOString()).run();
    expect((await f.request(actor,actor.id,{justification:"Exclusão simulada pelo teste"},true)).status).toBe(409);
    expect(await db.prepare("SELECT active FROM company_memberships WHERE company_id=?1 AND user_id=?2").bind(company,actor.id).first("active")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?1").bind(actor.id).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM password_resets WHERE user_id=?1").bind(actor.id).first("n")).toBe(1);
    expect(await db.prepare("SELECT email FROM users WHERE id=?1").bind(actor.id).first("email")).toBe(actor.email);
  });
  it("duas remoções simultâneas preservam ao menos um acesso ativo",async()=>{
    const f=await fixture(2),[a,b]=f.actors;
    const results=await Promise.all([f.request(a,a.id,{active:false}),f.request(b,b.id,{platform_role:"user"})]);
    expect(results.map(r=>r.status).sort()).toEqual([200,409]);
    expect(await f.activeCount()).toBe(1);
  });
  it("permite anonimizar outro Superadmin e elimina seus códigos de recuperação",async()=>{
    const f=await fixture(2),[actor,target]=f.actors;
    await db.prepare("INSERT INTO password_resets(user_id,code_hash,expires_at) VALUES (?1,'erase-me',?2)").bind(target.id,new Date(Date.now()+86400000).toISOString()).run();
    expect((await f.request(actor,target.id,{justification:"Exclusão solicitada em teste"},true)).status).toBe(200);
    expect(await f.activeCount()).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM password_resets WHERE user_id=?1").bind(target.id).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?1").bind(target.id).first("n")).toBe(0);
  });
  it("contas Superadmin inativas não contam como substituto; ativar outra permite remover a anterior",async()=>{
    const f=await fixture(),actor=f.actors[0],replacement=await user();
    await db.prepare("UPDATE users SET active=0,platform_role='superadmin' WHERE id=?1").bind(replacement.id).run();
    expect((await f.request(actor,actor.id,{platform_role:"user"})).status).toBe(409);
    expect((await f.request(actor,replacement.id,{active:true})).status).toBe(200);
    expect((await f.request(actor,actor.id,{platform_role:"user"})).status).toBe(200);
    expect(await f.activeCount()).toBe(1);
  });
  it("protege DELETE direto no banco sem impedir rotação de senha",async()=>{
    const f=await fixture(),actor=f.actors[0];
    await expect(db.prepare("DELETE FROM users WHERE id=?1").bind(actor.id).run()).rejects.toThrow(/TIGU_LAST_SUPERADMIN/);
    expect((await f.request(actor,actor.id,{reset_password:"SenhaPermitida#2026"})).status).toBe(200);
    expect(await f.activeCount()).toBe(1);
    expect(await db.prepare("SELECT must_change_password FROM users WHERE id=?1").bind(actor.id).first("must_change_password")).toBe(1);
  });
});
