/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { env } from "cloudflare:test";
import schema1 from "../migrations/0001_init.sql";
import schema6 from "../migrations/0006_request_rate_limits.sql";
import { changePasswordAtomically } from "../api/lib/password-change";
import { createSession } from "../api/lib/auth";
import { hashPassword,sha256hex } from "../api/lib/crypto";
import { app } from "../api/index";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"password-change-race-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeAll(async()=>{
  for(const schema of [schema1,schema6]) for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function user(hash="original-hash"){
  const email=`rotation-${crypto.randomUUID()}@tigu.test`;
  const id=Number((await db.prepare("INSERT INTO users(name,email,password_hash) VALUES ('Pessoa',?1,?2)").bind(email,hash).run()).meta.last_row_id);
  return {id,email};
}
async function issue(userId:number,expectedHash:string){
  const issuer=new Hono<{Bindings:Env}>();
  issuer.get("/",async c=>c.json({created:await createSession(c,userId,expectedHash)}));
  return issuer.request("http://local.test/",{},e,ctx);
}
describe("troca de senha: concorrência e credenciais antigas",()=>{
  it("duas trocas validadas pela mesma senha têm um só vencedor",async()=>{
    const u=await user();
    const results=await Promise.all([
      changePasswordAtomically(db,u.id,"original-hash","new-hash-a"),
      changePasswordAtomically(db,u.id,"original-hash","new-hash-b"),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await db.prepare("SELECT password_hash FROM users WHERE id=?1").bind(u.id).first("password_hash")).toBe(results[0]?"new-hash-a":"new-hash-b");
  });
  it("login com credencial já substituída não emite cookie nem recria sessão",async()=>{
    const u=await user();
    expect(await changePasswordAtomically(db,u.id,"original-hash","current-hash")).toBe(true);
    const response=await issue(u.id,"original-hash");
    expect(await response.json()).toEqual({created:false});
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?1").bind(u.id).first("n")).toBe(0);
    expect(await (await issue(u.id,"current-hash")).json()).toEqual({created:true});
  });
  it("troca obsoleta preserva a sessão emitida após a troca vencedora",async()=>{
    const u=await user();
    await changePasswordAtomically(db,u.id,"original-hash","current-hash");
    await issue(u.id,"current-hash");
    expect(await changePasswordAtomically(db,u.id,"original-hash","stale-hash")).toBe(false);
    expect(await db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?1").bind(u.id).first("n")).toBe(1);
  });
  it("troca real invalida código de recuperação anterior e todas as sessões antigas",async()=>{
    const password="SenhaOriginal#2026",u=await user(await hashPassword(password)),token=crypto.randomUUID();
    await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,?3)").bind(await sha256hex(`${token}:${e.SESSION_SECRET}:${u.id}`),u.id,new Date(Date.now()+86400000).toISOString()).run();
    const cookie=`aurum_session=uid.${u.id}.${token}`;
    const request=(path:string,body:object)=>app.request(path,{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify(body)},e,ctx);
    const recover=await request("/api/auth/recover",{email:u.email});
    const code=(await recover.json() as {demo_code:string}).demo_code;
    expect(code).toHaveLength(10);
    const changed=await request("/api/auth/password",{current:password,next:"SenhaNovaDiferente#2026"});
    expect(changed.status).toBe(200);
    expect(changed.headers.get("set-cookie")).toBeTruthy();
    expect((await request("/api/auth/recover/verify",{email:u.email,code,password:"SenhaAtaque#2026"})).status).toBe(400);
    const me=await app.request("/api/auth/me",{headers:{cookie}},e,ctx);
    expect(await me.json()).toEqual({user:null});
    expect(await db.prepare("SELECT count(*) n FROM password_resets WHERE user_id=?1 AND used_at IS NULL").bind(u.id).first("n")).toBe(0);
  });
});
