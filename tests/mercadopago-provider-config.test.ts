import { describe, expect, it } from "vitest";
import type { Env } from "../api/types";
import { mercadoPagoNotificationUrl, mpProvider, pickPaymentProvider } from "../api/lib/payments";
import { createSubscriptionPix } from "../api/lib/subscription-billing";

const ready = (changes: Partial<Env> = {}): Env => ({
  APP_ENV: "production",
  TIGU_STAGING: "0",
  PAYMENTS_MOCK: "0",
  MP_ACCESS_TOKEN: "sandbox-token-for-unit-tests",
  MP_WEBHOOK_SECRET: "sandbox-webhook-secret",
  PUBLIC_URL: "https://tigu.example.com",
  ...changes,
} as Env);

describe("Pix: pré-requisitos antes de criar cobranças reais", () => {
  it("gera callback público HTTPS apenas na rota exata de webhook", () => {
    expect(mercadoPagoNotificationUrl(ready())).toBe("https://tigu.example.com/api/webhooks/mercadopago");
    expect(mercadoPagoNotificationUrl(ready({ PUBLIC_URL: "https://tigu.example.com/" }))).toBe("https://tigu.example.com/api/webhooks/mercadopago");
    expect(pickPaymentProvider(ready()).provider?.kind).toBe("mercadopago");
  });

  it.each([
    "", "http://tigu.example.com", "/api",
    "https://tigu.example.com/redirect",
    "https://tigu.example.com/?key=1",
    "https://tigu.example.com/#frag",
    "https://user:pass@tigu.example.com",
    "https://localhost", "https://127.0.0.1",
    "https://tigu.example.com:8443",
    " https://tigu.example.com",
  ])("bloqueia endereço de callback inválido: %s", async (publicUrl) => {
    const e = ready({ PUBLIC_URL: publicUrl });
    expect(mercadoPagoNotificationUrl(e)).toBeNull();
    expect(pickPaymentProvider(e).provider).toBeNull();
    const attempt = await mpProvider(e).createPixPayment({
      amountCents: 1000, externalReference: "TIGU-TEST",
      description: "Teste", payerEmail: "demo@example.com",
    });
    expect(attempt.ok).toBe(false);
    const sub = await createSubscriptionPix(e, 1, "demo@example.com", "pro");
    expect(sub).toMatchObject({ ok: false, status: 503 });
  });

  it("não libera recarga sem token ou segredo do webhook", async () => {
    for (const missing of [{ MP_ACCESS_TOKEN: "" }, { MP_WEBHOOK_SECRET: "" }]) {
      const e = ready(missing);
      expect(pickPaymentProvider(e).provider).toBeNull();
      const result = await mpProvider(e).createPixPayment({
        amountCents: 1000, externalReference: "TIGU-TEST",
        description: "Teste", payerEmail: "demo@example.com",
      });
      expect(result.ok).toBe(false);
      expect((await createSubscriptionPix(e, 1, "demo@example.com", "pro")).ok).toBe(false);
    }
  });

  it("mantém homologação isolada e mock local, sem liberar mock em produção", () => {
    expect(pickPaymentProvider(ready({ TIGU_STAGING: "1" })).provider).toBeNull();
    expect(pickPaymentProvider(ready({
      APP_ENV: "development", MP_ACCESS_TOKEN: "",
      PAYMENTS_MOCK: "1", MP_WEBHOOK_SECRET: "", PUBLIC_URL: "",
    })).provider?.kind).toBe("mock");
    expect(pickPaymentProvider(ready({ PAYMENTS_MOCK: "1" })).provider).toBeNull();
  });
});
