/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import rates from "../migrations/0006_request_rate_limits.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import type { Env } from "../api/types";

const db = env.DB as D1Database;
const e = { ...env, APP_ENV: "development", SESSION_SECRET: "session-navigation-test-secret-32-characters" } as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
beforeAll(async () => {
  for (const sql of (schema + "\n" + rates).replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean))
    await db.prepare(sql).run();
});

describe("autenticacao: navegacao legitima e protecao contra abuso", () => {
  it("consulta de sessao nao expira artificialmente apos mais de 25 aberturas do painel", async () => {
    const id = Number((await db.prepare(
      "INSERT INTO users(name,email,password_hash) VALUES ('Usuario',?1,'hash-seguro')")
      .bind(`navegacao-${crypto.randomUUID()}@tigu.test`).run()).meta.last_row_id);
    const token = crypto.randomUUID();
    const hash = await sha256hex(`${token}:${e.SESSION_SECRET}:${id}`);
    await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,'2099-01-01T00:00:00Z')")
      .bind(hash,id).run();
    const ip = "nav-" + crypto.randomUUID();
    for (let i=0; i<40; i++) {
      const response = await app.request("/api/auth/me", {
        headers:{cookie:`aurum_session=uid.${id}.${token}`,"cf-connecting-ip":ip},
      },e,ctx);
      expect(response.status, `consulta ${i+1} nao pode derrubar a sessao`).toBe(200);
      const body = await response.json() as {user:{id:number}|null};
      expect(body.user?.id).toBe(id);
    }
  });
  it("continua limitando chamadas de escrita em autenticacao", async () => {
    const ip = "login-guard-" + crypto.randomUUID();
    for (let i=0;i<25;i++) {
      const response=await app.request("/api/auth/logout",{
        method:"POST",headers:{"cf-connecting-ip":ip},
      },e,ctx);
      expect(response.status,`escrita ${i+1} dentro do limite`).toBe(200);
    }
    const excess=await app.request("/api/auth/logout",{
      method:"POST",headers:{"cf-connecting-ip":ip},
    },e,ctx);
    expect(excess.status).toBe(429);
  });
});
