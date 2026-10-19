/// <reference types="@cloudflare/vitest-pool-workers" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { consumePasswordReset } from "../api/lib/password-reset";
import { app } from "../api/index";
import type { Env } from "../api/types";

const db = env.DB as D1Database;
const at = "2026-10-19T15:00:00Z";
beforeAll(async () => {
  for (const sql of schema.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean))
    await db.prepare(sql).run();
});

async function fixture() {
  const email = `reset-atomic-${crypto.randomUUID()}@tigu.test`;
  const user = await db.prepare("INSERT INTO users (name,email,password_hash,must_change_password) VALUES ('Reset',?1,'original',1)").bind(email).run();
  const userId = Number(user.meta.last_row_id);
  const reset = await db.prepare("INSERT INTO password_resets (user_id,code_hash,expires_at) VALUES (?1,'correct-code','2026-10-19T15:30:00Z')").bind(userId).run();
  await session(userId);
  return { userId, resetId: Number(reset.meta.last_row_id), codeHash: "correct-code", passwordHash: "first-password", at };
}
async function session(userId: number) {
  await db.prepare("INSERT INTO sessions (token_hash,user_id,expires_at) VALUES (?1,?2,'2026-10-20T15:00:00Z')").bind(crypto.randomUUID(),userId).run();
}
async function state(userId: number) {
  return db.prepare("SELECT password_hash,must_change_password,(SELECT count(*) FROM sessions WHERE user_id=users.id) AS sessions FROM users WHERE id=?1").bind(userId).first();
}

describe("recuperação: consumo único no D1", () => {
  it("repetição no mesmo segundo não troca senha nem encerra nova sessão", async () => {
    const input = await fixture();
    expect(await consumePasswordReset(db,input)).toBe(true);
    expect(await state(input.userId)).toEqual({password_hash:"first-password",must_change_password:0,sessions:0});
    await session(input.userId);
    expect(await consumePasswordReset(db,{...input,passwordHash:"replayed-password"})).toBe(false);
    expect(await state(input.userId)).toEqual({password_hash:"first-password",must_change_password:0,sessions:1});
  });
  it("duas transações concorrentes têm apenas um vencedor", async () => {
    const input = await fixture();
    const results = await Promise.all([
      consumePasswordReset(db,input),
      consumePasswordReset(db,{...input,passwordHash:"second-password"}),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const row = await state(input.userId) as {password_hash:string;sessions:number};
    expect(row.password_hash).toBe(results[0] ? "first-password" : "second-password");
    expect(row.sessions).toBe(0);
  });
  it.each(["expired","exhausted","wrong-code","wrong-user"])("recusa %s e preserva senha e sessões", async reason => {
    const input = await fixture();
    if (reason === "expired") input.at = "2026-10-19T15:30:00Z";
    if (reason === "exhausted") await db.prepare("UPDATE password_resets SET attempts=5 WHERE id=?1").bind(input.resetId).run();
    if (reason === "wrong-code") input.codeHash = "wrong-code";
    if (reason === "wrong-user") input.userId = (await fixture()).userId;
    expect(await consumePasswordReset(db,input)).toBe(false);
    expect(await state(input.userId)).toEqual({password_hash:"original",must_change_password:1,sessions:1});
  });
});

describe("recuperação: validação antes de consultar D1", () => {
  it.each([null, [], {email:123}, {email:{}}, {}])("recusa corpo inválido %j sem erro interno", async body => {
    for (const path of ["/api/auth/recover","/api/auth/recover/verify"]) {
      const response = await app.request(path, {
        method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body),
      }, {...env,APP_ENV:"development"} as Env);
      expect(response.status).toBe(422);
    }
  });
  it("recusa senha acima do limite antes de gerar hash", async () => {
    const response = await app.request("/api/auth/recover/verify", {
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({email:"valid@tigu.test",code:"ABCD123456",password:"x".repeat(129)}),
    }, {...env,APP_ENV:"development"} as Env);
    expect(response.status).toBe(422);
  });
});
