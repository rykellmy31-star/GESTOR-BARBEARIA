/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0006_request_rate_limits.sql";
import { persistentRateLimit, purgeRequestRateLimits } from "../api/lib/rate-limit";
const db = env.DB as D1Database;
beforeAll(async () => {
  for (const sql of schema.replace(/--[^\n]*/g, "").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
describe("limites persistentes no D1", () => {
  it("contabiliza concorrentes atomicamente e não depende da memória da instância", async () => {
    const key = crypto.randomUUID();
    const attempts = await Promise.all(Array.from({length:12},()=>persistentRateLimit(db,"secret",key,3,60000,1000)));
    expect(attempts.filter(Boolean)).toHaveLength(3);
    expect(await persistentRateLimit(db,"secret",key,3,60000,60999)).toBe(false);
    expect(await persistentRateLimit(db,"secret",key,3,60000,61000)).toBe(true);
  });
  it("separa contas, rotas e empresas e não armazena dados pessoais em claro", async () => {
    const id = crypto.randomUUID();
    const key = `login:pessoa-${id}@example.test:198.51.100.7`;
    expect(await persistentRateLimit(db,"secret",key,1,60000,1000)).toBe(true);
    expect(await persistentRateLimit(db,"secret",key,1,60000,1000)).toBe(false);
    expect(await persistentRateLimit(db,"secret",key+":outra-empresa",1,60000,1000)).toBe(true);
    const rows = await db.prepare("SELECT fingerprint FROM request_rate_limits").all<{fingerprint:string}>();
    expect(rows.results.every(r=>/^[a-f0-9]{64}$/.test(r.fingerprint))).toBe(true);
    expect(JSON.stringify(rows.results)).not.toContain("198.51.100.7");
    expect(JSON.stringify(rows.results)).not.toContain("@example.test");
  });
  it("limpa somente janelas antigas, preservando o limite ativo", async () => {
    const now = Date.now(),key=crypto.randomUUID();
    await persistentRateLimit(db,"secret",key+":old",1,1000,now-2*86400000);
    await persistentRateLimit(db,"secret",key,1,60000,now);
    await purgeRequestRateLimits(db,now);
    expect(await persistentRateLimit(db,"secret",key,1,60000,now)).toBe(false);
    expect(await db.prepare("SELECT count(*) n FROM request_rate_limits WHERE reset_at<?1").bind(now-86400000).first("n")).toBe(0);
  });
});
