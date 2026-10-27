import { describe, expect, it } from "vitest";
import { app } from "../api/index";
import type { Env } from "../api/types";

const ctx = { waitUntil: () => { throw new Error("Não deve processar evento inválido"); } } as unknown as ExecutionContext;
const noDb = {
  prepare() { throw new Error("JSON inválido jamais deve acessar o D1"); },
} as unknown as D1Database;
const base = {
  APP_ENV: "production", TIGU_STAGING: "0", DB: noDb,
  MP_WEBHOOK_SECRET: "segredo-assinatura-somente-testes",
} as Env;

function post(body: unknown, env: Env = base, path = "/api/webhooks/mercadopago") {
  return app.request(path, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }, env, ctx);
}

describe("Webhooks Pix e Meta: entradas externas e isolamento", () => {
  it.each([null, 1, "texto", [], [1], true])("ignora JSON não-objeto sem erro interno: %j", async payload => {
    const response = await post(payload);
    expect(response.status).toBe(200);
    expect((await response.json() as { ignored: string }).ignored).toBe("evento inválido");
  });

  it.each([{}, { data: null }, { data: {} }, { data: { id: {} } },
    { data: { id: [] } }, { data: { id: true } },
    { data: { id: "a".repeat(101) } }, { data: { id: -1 } }, { data: { id: 1.5 } },
  ])("ignora identificadores Pix ausentes ou inválidos antes de chegar ao D1", async payload => {
    const response = await post(payload);
    expect(response.status).toBe(200);
    expect((await response.json() as { ignored: string }).ignored).toBe("data.id inválido");
  });

  it("rejeita evento bem formado sem assinatura antes de qualquer gravação", async () => {
    const response = await post({ type: "payment", action: "payment.updated", data: { id: 12345 } });
    expect(response.status).toBe(401);
  });

  it("mantém webhook GET de verificação Meta desligado na homologação", async () => {
    const e = { ...base, TIGU_STAGING: "1", WHATSAPP_WEBHOOK_VERIFY_TOKEN: "token-ficticio" } as Env;
    const response = await app.request(
      "/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=token-ficticio&hub.challenge=abc123",
      {}, e, ctx,
    );
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("abc123");
  });

  it("não permite webhooks POST no staging, inclusive com JSON inválido", async () => {
    const e = { ...base, TIGU_STAGING: "1" } as Env;
    const mp = await post(null, e);
    const meta = await post(null, e, "/api/webhooks/whatsapp");
    expect(mp.status).toBe(403);
    expect(meta.status).toBe(403);
  });
});
