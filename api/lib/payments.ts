// ============================================================================
// PAGAMENTOS (recarga de créditos via Pix) — camada de provedor.
// Regra inegociável: CRÉDITO SÓ entra com pagamento confirmado pela API do
// gateway (re-consulta GET /v1/payments/{id} no webhook) — nunca por
// "página de sucesso", nunca por print, nunca por presunção de webhook.
// ============================================================================
import type { Env } from "../types";
import { nowIso } from "./utils";

export interface PaymentProvider {
  kind: "mercadopago" | "mock";
  createPixPayment(inp: { amountCents: number; externalReference: string; description: string; payerEmail: string }): Promise<
    { ok: true; providerPaymentId: string; qrCodeText: string; qrCodeBase64: string; expiresAt: string | null } | { ok: false; error: string; uncertain?: boolean }
  >;
  getPaymentStatus(providerPaymentId: string): Promise<{ status: string; detail?: Record<string, unknown> }>;
}

const MP_BASE = "https://api.mercadopago.com";

export function mpProvider(env: Env): PaymentProvider {
  const token = env.MP_ACCESS_TOKEN || "";
  const auth = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  return {
    kind: "mercadopago",
    async createPixPayment(inp) {
      if (env.TIGU_STAGING === "1") return { ok: false, error: "Pix real bloqueado no ambiente de homologação." };
      if (!token) return { ok: false, error: "Gateway de pagamento não configurado (MP_ACCESS_TOKEN ausente)." };
      const body = {
        transaction_amount: Math.round(inp.amountCents / 100 * 100) / 100,
        description: inp.description,
        payment_method_id: "pix",
        external_reference: inp.externalReference,
        notification_url: `${env.PUBLIC_URL || ""}/api/webhooks/mercadopago`.replace(/^\/\//, "https://"),
        expiration_date_interval: "01:00:00",
        date_of_expiration: new Date(Date.now() + 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, "-00:00"),
        payer: { email: inp.payerEmail || "checkout@tigu.app" },
      };
      try {
        const res = await fetch(`${MP_BASE}/v1/payments`, {
          method: "POST",
          headers: { ...auth, "X-Idempotency-Key": inp.externalReference }, // chave determinística p/ o pedido
          body: JSON.stringify(body),
        });
        const data = (await res.json().catch(() => ({}))) as { id?: number; status?: string; point_of_interaction?: { transaction_data?: { qr_code?: string; qr_code_base64?: string; expires_in?: string } }; message?: string; error?: string };
        if (!res.ok || !data.id) return { ok: false, error: data.message || data.error || `HTTP ${res.status}` };
        return {
          ok: true,
          providerPaymentId: String(data.id),
          qrCodeText: data.point_of_interaction?.transaction_data?.qr_code ?? "",
          qrCodeBase64: data.point_of_interaction?.transaction_data?.qr_code_base64 ?? "",
          expiresAt: data.point_of_interaction?.transaction_data?.expires_in ? new Date(data.point_of_interaction.transaction_data.expires_in).toISOString().replace(/\.\d{3}Z$/, "Z") : null,
        };
      } catch (e) {
        // Uma falha de rede não prova que o gateway deixou de criar o Pix.
        return { ok: false, error: String(e), uncertain: true };
      }
    },
    async getPaymentStatus(id) {
      if (env.TIGU_STAGING === "1") return { status: "error" };
      if (!token) return { status: "error" };
      const res = await fetch(`${MP_BASE}/v1/payments/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${token}` } });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      return { status: String((data as { status?: string }).status ?? "not_found"), detail: data };
    },
  };
}

/** Mock dev/teste: QR fake e "confirmação" por rota local explícita (nunca em prod). */
export function mockPaymentProvider(env: Env): PaymentProvider & { confirm(id: string): Promise<void> } {
  const store = new Map<string, string>();
  return {
    kind: "mock",
    async createPixPayment(inp) {
      const id = `mockpay-${inp.externalReference}`;
      store.set(inp.externalReference, "pending");
      store.set(id, "pending");
      return {
        ok: true,
        providerPaymentId: id,
        qrCodeText: `00020126580014BR.GOV.BCB.PIX0136mock-tigu-${inp.externalReference}52040000530398654${String(inp.amountCents / 100).length}${(inp.amountCents / 100).toFixed(2)}5802BR`,
        qrCodeBase64: "",
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      };
    },
    async getPaymentStatus(id) {
      const ref = id.replace(/^mockpay-/, "");
      const st = store.get(id) ?? store.get(ref) ?? (env.WHATSAPP_MOCK === "1" ? "approved" : "not_found");
      return { status: st };
    },
    async confirm(id) {
      store.set(id, "approved");
      store.set(id.replace(/^mockpay-/, ""), "approved");
    },
  };
}

export function pickPaymentProvider(env: Env, demo: boolean): { provider: PaymentProvider | null; error?: string } {
  if (env.TIGU_STAGING === "1") return { provider: null, error: "Recarga Pix desativada no ambiente de homologação." };
  if (env.PAYMENTS_MOCK === "1" || (demo && !env.MP_ACCESS_TOKEN)) {
    if (env.APP_ENV === "production" && env.PAYMENTS_MOCK !== "1") return { provider: null, error: "Pagamentos indisponíveis no momento." };
    if (env.APP_ENV === "production" && env.PAYMENTS_MOCK === "1") return { provider: null, error: "Pagamentos indisponíveis no momento." };
    return { provider: mockPaymentProvider(env) };
  }
  if (!env.MP_ACCESS_TOKEN) return { provider: null, error: "Pix não configurado neste ambiente (recargas manuais pelo Tigu seguem disponíveis)." };
  return { provider: mpProvider(env) };
}

// ── Verificação de assinatura do webhook MP (x-signature) ──────────────────
// Formato documentado: "ts=<ts>;v1=<hmac>" com manifest `id:{data.id};request-id:{x-request-id};ts:{ts};`
export async function verifyMpWebhookSignature(secret: string, xSignature: string | null, xRequestId: string | null, dataId: string): Promise<boolean> {
  if (!secret) return false; // sem segredo → rota dev pode aceitar; produção recusa (chamador decide)
  if (!xSignature) return false;
  const parts = Object.fromEntries(xSignature.split(/[;,]/).map((kv) => kv.trim().split("=") as [string, string]));
  const ts = parts.ts ?? "";
  const v1 = parts.v1 ?? "";
  if (!ts || !v1) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${xRequestId ?? ""};ts:${ts};`;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(manifest));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  if (hex.length !== v1.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ v1.charCodeAt(i);
  return diff === 0;
}

export function topupCode(): string {
  const a = Array.from(crypto.getRandomValues(new Uint8Array(5))).map((b) => b.toString(36).padStart(2, "0").replace(/[^a-z0-9]/gi, "")).join("");
  return `RGA-${a.toUpperCase().slice(0, 8)}`;
}

export function paymentWebhookUid(provider: string, id: string, status: string): string {
  return `${provider}:${id}:${status}`;
}

export const nowIsoStr = nowIso;
