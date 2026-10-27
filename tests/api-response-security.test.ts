/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import rateLimitSchema from "../migrations/0006_request_rate_limits.sql";
import { app } from "../api/index";
import type { Env } from "../api/types";
const e = { ...env, APP_ENV: "production" } as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
beforeAll(async () => {
  for (const sql of rateLimitSchema.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean))
    await e.DB.prepare(sql).run();
});
function protectedResponse(response: Response) {
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
}
describe("privacidade das respostas da API", () => {
  it("impede armazenamento de sessão anônima e diagnóstico público em cache", async () => {
    for (const path of ["/api/auth/me", "/api/health"]) {
      const response = await app.request(path, {}, e, ctx);
      expect(response.status).toBe(200);
      protectedResponse(response);
    }
  });
  it("preserva cabeçalhos em rejeição de origem e rota inexistente", async () => {
    const forbidden = await app.request("https://tigu.test/api/auth/login", {
      method: "POST", headers: { host: "tigu.test", origin: "https://outro.test", "content-type": "application/json" }, body: "{}",
    }, e, ctx);
    expect(forbidden.status).toBe(403);
    protectedResponse(forbidden);
    const missing = await app.request("/api/does-not-exist", {}, e, ctx);
    expect(missing.status).toBe(404);
    protectedResponse(missing);
  });
  it("falha interna de produção não retorna diagnóstico ou comando de desenvolvimento", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const broken = { ...e, DB: { prepare() { throw new Error("private-database-detail"); } } as unknown as D1Database };
      const response = await app.request("/api/marketing/contact", {}, broken, ctx);
      expect(response.status).toBe(500);
      protectedResponse(response);
      const body = await response.text();
      expect(body).not.toContain("private-database-detail");
      expect(body).not.toContain("npm run");
      expect(body).not.toContain("Migrations");
      expect(JSON.parse(body).detail).toBeUndefined();
    } finally { log.mockRestore(); }
  });
});
