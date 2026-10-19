import { describe, expect, it } from "vitest";
import { verifyMpWebhookSignature } from "../api/lib/payments";

async function signed(secret: string, id: string, requestId: string, ts: string) {
  const manifest = `id:${id.toLowerCase()};request-id:${requestId};ts:${ts};`;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest));
  const hex = [...new Uint8Array(signature)].map(b => b.toString(16).padStart(2, "0")).join("");
  return `ts=${ts},v1=${hex}`;
}

describe("Mercado Pago: autenticidade do webhook Pix", () => {
  const secret = "tigu-test-webhook-secret";
  const id = "123456789";
  const requestId = "req-test-123";
  const ts = "1792400000";

  it("aceita HMAC válido com separadores documentados", async () => {
    const signature = await signed(secret, id, requestId, ts);
    expect(await verifyMpWebhookSignature(secret, signature, requestId, id)).toBe(true);
    expect(await verifyMpWebhookSignature(secret, signature.replace(",", ";"), requestId, id)).toBe(true);
  });

  it("rejeita assinatura ausente e segredo vazio", async () => {
    expect(await verifyMpWebhookSignature(secret, null, requestId, id)).toBe(false);
    expect(await verifyMpWebhookSignature("", await signed(secret, id, requestId, ts), requestId, id)).toBe(false);
  });

  it("rejeita alterações de id, request-id, timestamp e HMAC", async () => {
    const signature = await signed(secret, id, requestId, ts);
    expect(await verifyMpWebhookSignature(secret, signature, requestId, "987654321")).toBe(false);
    expect(await verifyMpWebhookSignature(secret, signature, "other-request", id)).toBe(false);
    expect(await verifyMpWebhookSignature(secret, signature.replace(ts, "1792400001"), requestId, id)).toBe(false);
    expect(await verifyMpWebhookSignature(secret, signature.replace(/.$/, signature.endsWith("0") ? "1" : "0"), requestId, id)).toBe(false);
  });
});
