// ============================================================================
// WEBHOOKS públicos (sem sessão; validação por assinatura/segredo).
//  /api/webhooks/whatsapp     → Meta (hub verification + eventos)
//  /api/webhooks/mercadopago  → Pix (aviso; a CONFIRMAÇÃO vem re-consultando)
// Resposta SEMPRE 200 rápido p/ Meta e MP (política de retry deles); erros
// ficam registrados na tabela de eventos para reprocessamento manual.
// ============================================================================
import { Hono } from "hono";
import type { Env } from "../types";
import { ingestWhatsappWebhook } from "../lib/messaging/jobs";
import { verifyWebhookSignature } from "../lib/messaging/provider";
import { verifyMpWebhookSignature, paymentWebhookUid } from "../lib/payments";
import { confirmTopupFromProvider } from "../lib/topup";
import { confirmSubscriptionPix } from "../lib/subscription-billing";
import { nowIso } from "../lib/utils";

export const webhooksRouter = new Hono<{ Bindings: Env }>();

webhooksRouter.get("/whatsapp", async (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const expected = c.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || "";
  if (mode === "subscribe" && expected && token === expected) return new Response(challenge, { status: 200 });
  return new Response("verification failed", { status: 403 });
});

webhooksRouter.post("/whatsapp", async (c) => {
  if (c.env.TIGU_STAGING === "1") return c.json({ error: "Webhooks Meta reais estão desativados na homologação." }, 403);
  const raw = await c.req.text();
  const secret = c.env.WHATSAPP_APP_SECRET || "";
  if (secret) {
    const ok = await verifyWebhookSignature(secret, raw, c.req.header("x-hub-signature-256") ?? null);
    if (!ok) return c.json({ error: "assinatura inválida" }, 401);
  } else if (c.env.APP_ENV === "production") {
    // recusar sem segredo configurado em produção (segurança > conveniência)
    return c.json({ error: "webhook não seguro: configure WHATSAPP_APP_SECRET" }, 503);
  }
  let body: unknown = {};
  try { body = JSON.parse(raw); } catch { return c.json({ ok: true, ignored: "json inválido" }); }
  try {
    const res = await ingestWhatsappWebhook(c.env, body);
    return c.json({ ok: true, ...res });
  } catch (e) {
    console.error("[whatsapp-webhook]", String(e));
    return c.json({ error: "Falha temporária no processamento; reenvie o evento." }, 503);
  }
});

webhooksRouter.post("/mercadopago", async (c) => {
  if (c.env.TIGU_STAGING === "1") return c.json({ error: "Webhooks Pix reais estão desativados na homologação." }, 403);
  const raw = await c.req.text();
  let body: { type?: string; data?: { id?: string }; action?: string } = {};
  try { body = JSON.parse(raw); } catch { return c.json({ ok: true }); }
  const dataId = body.data?.id ?? "";
  if (!dataId) return c.json({ ok: true, ignored: "sem data.id" });

  const secret = c.env.MP_WEBHOOK_SECRET || "";
  if (secret) {
    const ok = await verifyMpWebhookSignature(secret, c.req.header("x-signature") ?? null, c.req.header("x-request-id") ?? null, dataId);
    if (!ok) return c.json({ error: "assinatura inválida" }, 401);
  } else if (c.env.APP_ENV === "production") {
    return c.json({ error: "configure MP_WEBHOOK_SECRET" }, 503);
  }

  const db = c.env.DB;
  const uid = paymentWebhookUid("mercadopago", dataId, body.action || "update");
  const ins = await db.prepare(`INSERT OR IGNORE INTO payment_webhook_events (provider, event_uid, payload, created_at) VALUES ('mercadopago', ?1, ?2, ?3)`).bind(uid, raw.slice(0, 4000), nowIso()).run();

  // responde 200 já; o processamento re-consulta o gateway (fonte da verdade)
  c.executionCtx.waitUntil(
    (async () => {
      // Recarga de créditos e assinatura usam o mesmo endpoint, mas
      // registros e efeitos são inteiramente separados por payment_id.
      const topup = await confirmTopupFromProvider(c.env,dataId,"webhook");
      const result = topup.ok ? topup : await confirmSubscriptionPix(c.env,dataId);
      if(result.ok && result.status==="paid") {
        await db.prepare("UPDATE payment_webhook_events SET processed=1 WHERE event_uid=?1")
          .bind(uid).run();
      }
    })().catch(e=>console.error("[mp-webhook]",String(e).slice(0,180)))
  );
  void ins;
  return c.json({ ok: true });
});
