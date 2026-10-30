import { Hono } from "hono";
import type { Env } from "../types";
import { nowIso } from "../lib/utils";

// Callback independente dos webhooks Meta. Somente a Evolution deve conhecer o segredo.
export const evolutionWebhookRouter = new Hono<{ Bindings: Env }>();
function constantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i=0; i<a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
evolutionWebhookRouter.post("/", async (c) => {
  if (c.env.TIGU_STAGING === "1" && c.env.TIGU_EVOLUTION_LIVE !== "1") return c.json({error:"Webhook real bloqueado na homologação."},403);
  const secret = c.env.EVOLUTION_WEBHOOK_SECRET;
  if (!secret || secret.length<32) return c.json({error:"Webhook não configurado."},503);
  if (!constantTime(c.req.header("x-tigu-webhook-token") || "", secret)) return c.json({error:"Não autorizado."},401);
  const body = await c.req.json().catch(()=>null) as any;
  const instance = typeof body?.instance === "string" ? body.instance : "";
  if (!/^tigu-company-[1-9]\d*$/.test(instance)) return c.json({error:"Instância inválida."},400);
  const row = await c.env.DB.prepare("SELECT company_id FROM evolution_connections WHERE instance_name=?1 AND enabled=1")
    .bind(instance).first<{company_id:number}>();
  if (!row) return c.json({error:"Instância não cadastrada."},404);
  const ev = String(body?.event || "").replace(/[.-]/g,"_").toUpperCase();
  const data = body?.data ?? {};
  if (ev === "CONNECTION_UPDATE") {
    const state = String(data?.state ?? data?.instance?.state ?? "").toLowerCase();
    const status = state === "open" ? "connected" : "pending_setup";
    const phone = String(data?.number || data?.wuid || "").replace(/@.*$/,"").replace(/\D/g,"").slice(0,15);
    await c.env.DB.prepare(`UPDATE evolution_connections SET status=?1,
      display_phone=CASE WHEN ?2<>'' THEN ?2 ELSE display_phone END,
      connected_at=CASE WHEN ?1='connected' THEN COALESCE(connected_at,?3) ELSE connected_at END,
      updated_at=?3 WHERE company_id=?4 AND enabled=1`).bind(status,phone,nowIso(),row.company_id).run();
  }
  if (ev === "MESSAGES_UPDATE") {
    // Na Evolution v2 o ID WhatsApp está em data.keyId; messageId é
    // identificador INTERNO da Evolution e não deve ser usado para cruzar jobs.
    const keyId = typeof data?.keyId === "string" ? data.keyId
      : typeof data?.key?.id === "string" ? data.key.id : "";
    const deliveryStatus = String(data?.status || "").toUpperCase();
    if (keyId.length > 0 && keyId.length <= 160 && data?.fromMe !== false) {
      const db = c.env.DB;
      if (deliveryStatus === "DELIVERY_ACK") {
        await db.prepare(`UPDATE message_jobs SET status='delivered',
          delivered_at=COALESCE(delivered_at,?1),updated_at=?1
          WHERE company_id=?2 AND provider='evolution' AND provider_msg_id=?3 AND status='sent'`)
          .bind(nowIso(),row.company_id,keyId).run();
      } else if (deliveryStatus === "READ" || deliveryStatus === "PLAYED") {
        await db.prepare(`UPDATE message_jobs SET status='read',
          delivered_at=COALESCE(delivered_at,?1),
          read_at=COALESCE(read_at,?1),updated_at=?1
          WHERE company_id=?2 AND provider='evolution' AND provider_msg_id=?3
          AND status IN ('sent','delivered')`).bind(nowIso(),row.company_id,keyId).run();
      } else if (deliveryStatus === "ERROR") {
        await db.prepare(`UPDATE message_jobs SET status='failed',
          last_error='Falha de entrega informada pela Evolution',updated_at=?1
          WHERE company_id=?2 AND provider='evolution' AND provider_msg_id=?3
          AND status IN ('sent','delivered')`).bind(nowIso(),row.company_id,keyId).run();
      }
    }
  }
  if (ev === "MESSAGES_UPSERT" && data?.key?.fromMe === false) {
    const id = typeof data?.key?.id === "string" ? data.key.id : "";
    const jid = String(data?.key?.remoteJid ?? "");
    const number = jid.match(/^(\d{10,15})@s\.whatsapp\.net$/)?.[1] || "";
    if (id && id.length<=160 && number) {
      const text = String(data?.message?.conversation ?? data?.message?.extendedTextMessage?.text ?? "").slice(0,180);
      const inserted = await c.env.DB.prepare(`INSERT OR IGNORE INTO message_webhook_events
        (company_id,event_uid,status,raw_json,processed,created_at)
        VALUES (?1,?2,'received',?3,1,?4)`).bind(row.company_id,`evo:in:${instance}:${id}`,JSON.stringify({from:number,body:text}),nowIso()).run();
      if (inserted.meta.changes) await c.env.DB.prepare(`INSERT INTO notifications
        (company_id,audience,title,body,kind) VALUES (?1,'admin','Nova mensagem recebida no WhatsApp',?2,'message')`)
        .bind(row.company_id,`Contato ${number.slice(0,4)}••••${number.slice(-3)} enviou uma mensagem.`).run();
      // Respostas não são tratadas como consentimento ou comandos automáticos.
    }
  }
  return c.json({ok:true});
});
