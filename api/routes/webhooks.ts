// ============================================================================
// WEBHOOKS públicos (sem sessão; validação por assinatura/segredo).
//  /api/webhooks/whatsapp     → Meta (hub verification + eventos)
//  /api/webhooks/mercadopago  → Pix (aviso; a CONFIRMAÇÃO vem re-consultando)
// Resposta SEMPRE 200 rápido p/ Meta e MP (política de retry deles); erros
// ficam registrados na tabela de eventos para reprocessamento manual.
// ============================================================================
import { Hono } from "hono";
import { evolutionWebhookRouter } from "./evolution-webhook";
import type { Env } from "../types";
import { ingestWhatsappWebhook } from "../lib/messaging/jobs";
import { verifyWebhookSignature } from "../lib/messaging/provider";
import { verifyMpWebhookSignature, paymentWebhookUid } from "../lib/payments";
import { confirmTopupFromProvider } from "../lib/topup";
import { confirmBookingPix } from "../lib/booking-payments";
import { confirmOrderPix } from "../lib/order-payments";
import { merchantByWebhookKey } from "../lib/merchant-payments";
import { sellerPaymentsEnabled } from "../lib/seller-payments";
import { confirmSubscriptionPix } from "../lib/subscription-billing";
import { nowIso } from "../lib/utils";

export const webhooksRouter = new Hono<{ Bindings: Env }>();
webhooksRouter.route("/evolution", evolutionWebhookRouter);

webhooksRouter.get("/whatsapp", async (c) => {
  if (c.env.TIGU_STAGING === "1") return c.json({ error: "Verificação Meta desativada na homologação." }, 403);
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

// Webhook PRÓPRIO de cada barbearia. Não consulta nem credita a carteira TIGU.
// A assinatura é a da aplicação Mercado Pago conectada pelo proprietário.
webhooksRouter.post("/merchant-mercadopago/:key",async c=>{
 if(c.env.TIGU_STAGING==="1")return c.json({error:"Pagamentos reais bloqueados na homologação."},403);
 const merchant=await merchantByWebhookKey(c.env,c.req.param("key")||"");
 if(!merchant)return c.json({error:"Conta recebedora não encontrada."},404);
 const raw=await c.req.text();
 let body:unknown;
 try{body=JSON.parse(raw);}catch{return c.json({ok:true,ignored:"json"});}
 if(!body||typeof body!=="object"||Array.isArray(body))
  return c.json({ok:true,ignored:"payload"});
 const event=body as Record<string,unknown>;
 if(event.type!=="payment")return c.json({ok:true,ignored:"tipo"});
 const data=event.data&&typeof event.data==="object"&&!Array.isArray(event.data)?
  event.data as Record<string,unknown>:null;
 const rawId=data?.id??c.req.query("data.id");
 const paymentId=(typeof rawId==="string"||typeof rawId==="number")?String(rawId):"";
 if(!/^[0-9]{1,24}$/.test(paymentId))return c.json({ok:true,ignored:"id"});
 if(!await verifyMpWebhookSignature(merchant.webhookSecret,
  c.req.header("x-signature")??null,c.req.header("x-request-id")??null,paymentId))
  return c.json({error:"assinatura inválida"},401);
 // Responder falha transitória 503 para permitir reenvio; nunca confirmar
 // pagamento com base apenas na notificação.
 try {
  const booking=await confirmBookingPix(c.env,merchant.company_id,paymentId,"merchant");
  const result=booking.status==="not_found"?
   await confirmOrderPix(c.env,merchant.company_id,paymentId):booking;
  if(!result.ok&&result.status!=="not_found")
   return c.json({error:"Não foi possível conciliar com o recebedor."},503);
  return c.json({ok:true,status:result.status});
 }catch{
  return c.json({error:"Falha temporária ao conferir recebimento."},503);
 }
});

// Webhook Marketplace: confirmação sempre feita no Mercado Pago do profissional.
webhooksRouter.post("/seller-mercadopago/:companyId/:barberId",async c=>{
 if(!sellerPaymentsEnabled(c.env))return c.json({error:"Pix do profissional indisponível."},503);
 const co=c.req.param("companyId"),ba=c.req.param("barberId");
 if(!/^[1-9]\d{0,11}$/.test(co)||!/^[1-9]\d{0,11}$/.test(ba))
  return c.json({error:"Recebedor inválido."},400);
 const secret=c.env.MP_MARKETPLACE_WEBHOOK_SECRET||"";
 if(secret.length<16)return c.json({error:"Webhook não configurado."},503);
 const raw=await c.req.text();
 let body:unknown;
 try{body=JSON.parse(raw);}catch{return c.json({ok:true,ignored:"json"});}
 if(!body||typeof body!=="object"||Array.isArray(body))
  return c.json({ok:true,ignored:"payload"});
 const event=body as Record<string,unknown>;
 if(event.type!=="payment")return c.json({ok:true,ignored:"tipo"});
 const data=event.data&&typeof event.data==="object"&&!Array.isArray(event.data)
  ?event.data as Record<string,unknown>:null;
 const rawId=data?.id??c.req.query("data.id");
 const id=(typeof rawId==="string"||typeof rawId==="number")?String(rawId):"";
 if(!/^[0-9]{1,24}$/.test(id))return c.json({ok:true,ignored:"id"});
 const queryId=c.req.query("data.id");
 if(queryId&&queryId!==id)return c.json({error:"Identificador divergente."},401);
 if(!await verifyMpWebhookSignature(secret,c.req.header("x-signature")??null,
   c.req.header("x-request-id")??null,id))
  return c.json({error:"Assinatura inválida."},401);
 try{
  const result=await confirmBookingPix(c.env,Number(co),id,"seller");
  if(result.status==="not_found")return c.json({ok:true,ignored:"não associado"});
  if(!result.ok)return c.json({error:"Conciliação indisponível; reenvie o evento."},503);
  return c.json({ok:true,status:result.status});
 }catch{return c.json({error:"Conciliação falhou; reenvie o evento."},503);}
});

webhooksRouter.post("/mercadopago", async (c) => {
  if (c.env.TIGU_STAGING === "1") return c.json({ error: "Webhooks Pix reais estão desativados na homologação." }, 403);
  const raw = await c.req.text();
  // Não confiar nos tipos de JSON recebido de terceiros. Em particular,
  // null, arrays ou data.id como objeto não podem gerar erro 500 nem consulta ao gateway.
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return c.json({ ok: true, ignored: "json inválido" }); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    return c.json({ ok: true, ignored: "evento inválido" });
  const body = parsed as Record<string, unknown>;
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data)
    ? body.data as Record<string, unknown> : null;
  const idValue = data?.id ?? c.req.query("data.id");
  const dataId = typeof idValue === "string" ? idValue
    : typeof idValue === "number" && Number.isSafeInteger(idValue) && idValue >= 0 ? String(idValue) : "";
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(dataId))
    return c.json({ ok: true, ignored: "data.id inválido" });
  const action = typeof body.action === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(body.action)
    ? body.action : "update";

  const secret = c.env.MP_WEBHOOK_SECRET || "";
  if (secret) {
    const ok = await verifyMpWebhookSignature(secret, c.req.header("x-signature") ?? null, c.req.header("x-request-id") ?? null, dataId);
    if (!ok) return c.json({ error: "assinatura inválida" }, 401);
  } else if (c.env.APP_ENV === "production") {
    return c.json({ error: "configure MP_WEBHOOK_SECRET" }, 503);
  }

  const db = c.env.DB;
  const uid = paymentWebhookUid("mercadopago", dataId, action);
  const ins = await db.prepare(`INSERT OR IGNORE INTO payment_webhook_events (provider, event_uid, payload, created_at) VALUES ('mercadopago', ?1, ?2, ?3)`).bind(uid, raw.slice(0, 4000), nowIso()).run();

  // responde 200 já; o processamento re-consulta o gateway (fonte da verdade)
  c.executionCtx.waitUntil(
    (async () => {
      // Recarga de créditos e assinatura usam o mesmo endpoint, mas
      // registros e efeitos são inteiramente separados por payment_id.
      const topup = await confirmTopupFromProvider(c.env,dataId,"webhook");
      const subscription = topup.ok ? null : await confirmSubscriptionPix(c.env,dataId);
      const result = topup.ok ? topup : subscription ?? {ok:false,status:"not_found"};
      if(result.ok && result.status==="paid") {
        await db.prepare("UPDATE payment_webhook_events SET processed=1 WHERE event_uid=?1")
          .bind(uid).run();
      }
    })().catch(e=>console.error("[mp-webhook]",String(e).slice(0,180)))
  );
  void ins;
  return c.json({ ok: true });
});
