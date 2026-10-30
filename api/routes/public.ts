// ============================================================================
// Rotas PÚBLICAS por empresa: /api/c/:slug/... — site, agenda, reservas do
// cliente (lookup/cancelar/remarcar), loja. Isolamento: toda query usa o
// company_id resolvido no servidor a partir do slug.
// ============================================================================
import { Hono } from "hono";
import { z } from "zod";
import { generateBookingPix, lookupBookingPix } from "../lib/booking-payments";
import { merchantPixReady } from "../lib/merchant-payments";
import { sellerPixReady } from "../lib/seller-payments";
import { generateOrderPix, lookupOrderPix } from "../lib/order-payments";
import type { Env } from "../types";
import { err, json, normalizePhone, nowIso, brl } from "../lib/utils";
import { cid, ctxSettings, tenantMiddleware } from "../lib/tenant";
import { computeDaySlots, monthSummary, type BarberRow, type ServiceRow } from "../lib/availability";
import { createBooking, createBookingSchema, cancelBooking, rescheduleBooking, markBookingArrived } from "../lib/booking";
import { normalizePhone as np } from "../lib/utils";

async function findPublicBooking(db: D1Database, companyId: number, code: string, phone: string, listAll: boolean) {
  const tail = listAll ? " ORDER BY b.starts_at DESC LIMIT 10" : " ORDER BY b.starts_at DESC LIMIT 1";
  const where = `WHERE b.company_id = ?1 AND UPPER(b.code) = ?2 AND b.customer_phone = ?3`;
  const { results } = await db
    .prepare(
      `SELECT b.id, b.code, b.status, b.starts_at, b.ends_at, b.price_cents, b.payment_choice, bp.status AS payment_status, b.notes, b.checked_in_at, b.checked_in_source, b.allowed_cancel_until, b.barber_id, b.service_id, b.customer_name,
              s.name AS service_name, s.duration_min, br.name AS barber_name, br.photo AS barber_photo
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN barbers br ON br.id = b.barber_id
       LEFT JOIN booking_payments bp ON bp.booking_id=b.id AND bp.company_id=b.company_id
       ${where}${tail}`
    )
    .bind(companyId, code.toUpperCase().trim(), np(phone))
    .all<Record<string, unknown>>();
  return results;
}

export const publicRouter = new Hono<{ Bindings: Env }>();
publicRouter.use("*", tenantMiddleware({ auth: "none" }));

// ── endpoints granulares (usados por componentes do site) ─────────────────
publicRouter.get("/config", async (c) => {
  const company = c.get("company") as { id: number };
  const co = await c.env.DB.prepare(`SELECT demo FROM companies WHERE id=?1`).bind(company.id).first<{ demo: number }>();
  return json(c, { settings: { ...ctxSettings(c) }, demo_active: co?.demo === 1, payment_options: { after_service: true, pix_enabled: await merchantPixReady(c.env,company.id) } });
});
publicRouter.get("/barbers", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT id, slug, name, specialty, bio, photo, rating, reviews_count, work_days, work_start, work_end, active FROM barbers WHERE company_id=?1 AND active=1 ORDER BY sort, name`).bind(cid(c)).all();
  return json(c, { barbers: results });
});
publicRouter.get("/barbers/:id", async (c) => {
  const rawId = c.req.param("id");
  if (!/^[1-9]\d*$/.test(rawId)) return err(c, "Profissional inválido", 400);
  const barber = await c.env.DB.prepare(
    `SELECT id, slug, name, specialty, bio, photo, rating, reviews_count, work_days,
            work_start, work_end, break_start, break_end
       FROM barbers WHERE id=?1 AND company_id=?2 AND active=1`
  ).bind(Number(rawId), cid(c)).first();
  if (!barber) return err(c, "Profissional não encontrado", 404);
  const {results:linked}=await c.env.DB.prepare(
    "SELECT sb.service_id,COALESCE(sb.duration_override_min,s.duration_min) AS duration_min "+
    "FROM service_barbers sb JOIN services s ON s.id=sb.service_id AND s.company_id=?1 "+
    "WHERE sb.barber_id=?2 AND s.active=1"
  ).bind(cid(c),Number(rawId)).all<{service_id:number;duration_min:number}>();
  return json(c, { barber, service_durations:Object.fromEntries(
    linked.map(item=>[item.service_id,item.duration_min])
  ), pix_available: await sellerPixReady(c.env,cid(c),Number(rawId)) });
});
publicRouter.get("/services", async (c) => {
  const companyId = cid(c);
  const { results } = await c.env.DB.prepare(`SELECT s.* FROM services s WHERE s.company_id=?1 AND s.active=1 AND s.show_in_catalog=1 ORDER BY s.sort, s.name`).bind(companyId).all();
  // O assistente de agendamento precisa saber quais profissionais atendem
  // cada serviço. Nunca incluir barbeiros inativos ou de outra empresa.
  const { results: links } = await c.env.DB.prepare(
    `SELECT sb.service_id, sb.barber_id FROM service_barbers sb
       JOIN services s ON s.id=sb.service_id AND s.company_id=?1 AND s.active=1 AND s.show_in_catalog=1
       JOIN barbers b ON b.id=sb.barber_id AND b.company_id=?1 AND b.active=1`
  ).bind(companyId).all<{ service_id: number; barber_id: number }>();
  const byService = new Map<number, number[]>();
  for (const link of links) byService.set(link.service_id, [...(byService.get(link.service_id) ?? []), link.barber_id]);
  return json(c, { services: results.map((x: Record<string, unknown>) => ({
    ...x, barber_ids: byService.get(Number(x.id)) ?? [], price: Number(x.price_cents) / 100,
  })) });
});
publicRouter.get("/reviews", async (c) => {
  if (!ctxSettings(c).reviews_enabled) return json(c, { reviews: [] });
  const { results } = await c.env.DB.prepare(`SELECT r.id, r.rating, r.comment, r.customer_name, r.created_at, br.name AS barber_name FROM reviews r JOIN barbers br ON br.id=r.barber_id WHERE r.company_id=?1 ORDER BY r.id DESC LIMIT 30`).bind(cid(c)).all();
  return json(c, { reviews: results });
});

/** dados do site inteiro em 1 request (página inicial/landing do tenant) */
publicRouter.get("/site", async (c) => {
  const db = c.env.DB;
  const companyId = cid(c);
  const s = ctxSettings(c);
  const [barbers, services, products, reviews] = await Promise.all([
    db.prepare(`SELECT id, slug, name, specialty, bio, photo, rating, reviews_count FROM barbers WHERE company_id = ?1 AND active = 1 ORDER BY sort, name`).bind(companyId).all(),
    db.prepare(`SELECT id, slug, name, description, price_cents, duration_min, category, photo, id IN (SELECT service_id FROM service_barbers) AS has_barbers FROM services WHERE company_id = ?1 AND active = 1 AND show_in_catalog = 1 ORDER BY sort, name`).bind(companyId).all(),
    s.products_enabled
      ? db.prepare(`SELECT id, slug, name, description, price_cents, category, photo, stock > 0 AS in_stock, featured FROM products WHERE company_id = ?1 AND active = 1 ORDER BY featured DESC, name`).bind(companyId).all()
      : Promise.resolve({ results: [] as unknown[] }),
    s.reviews_enabled
      ? db.prepare(`SELECT r.rating, r.comment, r.customer_name, br.name AS barber_name, r.created_at FROM reviews r JOIN barbers br ON br.id = r.barber_id WHERE r.company_id = ?1 ORDER BY r.created_at DESC LIMIT 9`).bind(companyId).all()
      : Promise.resolve({ results: [] as unknown[] }),
  ]);
  return json(c, {
    company: { slug: c.req.param("slug"), name: s.shop_name },
    settings: { ...pickPublic(s) },
    barbers: barbers.results,
    services: (services.results as Record<string, unknown>[]).map((x) => ({ ...x, price: Number(x.price_cents) / 100 })),
    products: (products.results as Record<string, unknown>[]).map((x) => ({ ...x, price: Number(x.price_cents) / 100 })),
    reviews: reviews.results,
  });
});

function pickPublic(s: Record<string, unknown>): Record<string, unknown> {
  const keys = ["shop_name","tagline","about","phone","whatsapp","email","address","maps_query","instagram","facebook","logo_url","banner_url","brand","opening_hours","timezone","horizon_days","min_lead_min","slot_step_min","allow_online_cancel","allow_online_reschedule","cancel_cutoff_min","reschedule_cutoff_min","cancel_policy_text","reviews_enabled","products_enabled","whatsapp_buttons_enabled","reminder_lead_min"];
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = s[k];
  return out;
}

publicRouter.get("/availability", async (c) => {
  const db = c.env.DB;
  const companyId = cid(c);
  const barberId = Number(c.req.query("barberId"));
  const serviceId = Number(c.req.query("serviceId"));
  const day = c.req.query("day") || c.req.query("date") || "";
  if (!Number.isInteger(barberId) || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return err(c, "barberId e day=YYYY-MM-DD são obrigatórios", 400);
  const barber = await db.prepare(`SELECT id, name, work_days, work_start, work_end, break_start, break_end, active FROM barbers WHERE id = ?1 AND company_id = ?2`).bind(barberId, companyId).first<BarberRow>();
  if (!barber) return err(c, "Profissional não encontrado", 404);
  let service: ServiceRow | null = null;
  if (Number.isInteger(serviceId)) service = await db.prepare(`SELECT id, name, duration_min, price_cents FROM services WHERE id = ?1 AND company_id = ?2 AND active = 1`).bind(serviceId, companyId).first<ServiceRow>();
  if (!service) return err(c, "Serviço inválido", 400);
  const result = await computeDaySlots(db, { barber, service, day, settings: ctxSettings(c), mode: "public" });
  return json(c, result);
});

publicRouter.get("/availability-month", async (c) => {
  const db = c.env.DB;
  const companyId = cid(c);
  const barberId = Number(c.req.query("barberId"));
  const serviceId = Number(c.req.query("serviceId"));
  const month = c.req.query("month") || "";
  if (!/^\d{4}-\d{2}$/.test(month)) return err(c, "month=YYYY-MM é obrigatório", 400);
  const barber = await db.prepare(`SELECT id, name, work_days, work_start, work_end, break_start, break_end, active FROM barbers WHERE id = ?1 AND company_id = ?2`).bind(barberId, companyId).first<BarberRow>();
  const service = Number.isInteger(serviceId) ? await db.prepare(`SELECT id, name, duration_min, price_cents FROM services WHERE id = ?1 AND company_id = ?2 AND active = 1`).bind(serviceId, companyId).first<ServiceRow>() : null;
  if (!barber) return err(c, "Profissional não encontrado", 404);
  const days = await monthSummary(db, { barber, service, month, settings: ctxSettings(c) });
  return json(c, { month, days });
});

publicRouter.post("/bookings", async (c) => {
  const ip = c.req.header("cf-connecting-ip") || "local";
  const { rateLimit } = await import("../lib/auth");
  if (!(await rateLimit(c.env, `book:${ip}:${c.req.param("slug")}`, 12, 5 * 60_000))) return err(c, "Muitas tentativas de agendamento. Aguarde alguns minutos.", 429);
  const parsed = createBookingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const s = ctxSettings(c);
  if (parsed.data.paymentChoice === "pix" && !(await sellerPixReady(c.env,cid(c),parsed.data.barberId)))
    return err(c,"Profissional ainda não conectou seu Mercado Pago para receber Pix. Escolha pagar após o serviço.",503);
  if (parsed.data.paymentChoice === "pix" && !parsed.data.email)
    return err(c,"Informe um e-mail para gerar o Pix.",422);
  const company = c.get("company") as { id: number };
  const res = await createBooking(
    { env: c.env, db: c.env.DB, companyId: company.id, settings: s, origin: "cliente", user: null, demo: await demoFlag(c) },
    parsed.data
  );
  if (!res.ok) return err(c, res.message, res.status, res.issues);
  const db = c.env.DB;
  const b = await db.prepare(`SELECT b.*, s.name AS service_name, br.name AS barber_name FROM bookings b JOIN services s ON s.id=b.service_id JOIN barbers br ON br.id=b.barber_id WHERE b.id = ?1`).bind(res.bookingId).first<Record<string, unknown>>();
  const payment = parsed.data.paymentChoice === "pix"
    ? await generateBookingPix(c.env,company.id,res.bookingId) : null;
  return json(c, {
    payment, payment_choice: String(b?.payment_choice ?? "after_service"),
    booking: { ...(b ?? {}), starts_local: fmtLocal(String(res.startsAt), s.timezone), price: Number(b?.price_cents ?? 0) / 100 },
    cancel_token: res.cancelToken,
    allowed_cancel_until: res.allowedCancelUntil,
    policy: { allow_online_cancel: s.allow_online_cancel, allow_online_reschedule: s.allow_online_reschedule, cancel_cutoff_min: s.cancel_cutoff_min, reschedule_cutoff_min: s.reschedule_cutoff_min, cancel_policy_text: s.cancel_policy_text },
    messaging: { reminder: summarizeMsg(res.messaging), confirmation: summarizeMsg(res.confirmMessaging) },
    whatsapp_link: s.whatsapp ? waConfirmLink(s.whatsapp, b, s.timezone) : null,
  }, 201);
});

const pixLookupSchema = z.object({
  code: z.string().min(4).max(32),
  phone: z.string().min(8).max(20),
  cancel_token: z.string().uuid(),
});
publicRouter.post("/bookings/pix/status", async (c) => {
  const parsed = pixLookupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c,"Dados inválidos",422);
  const ip = c.req.header("cf-connecting-ip") || "local";
  const { rateLimit } = await import("../lib/auth");
  if (!(await rateLimit(c.env,"booking-pix-status:"+ip,15,300000)))
    return err(c,"Muitas consultas. Aguarde alguns minutos.",429);
  const payment = await lookupBookingPix(c.env,cid(c),
    parsed.data.code,parsed.data.phone,parsed.data.cancel_token);
  if (!payment) return err(c,"Pagamento não encontrado",404);
  return json(c,{payment});
});

async function demoFlag(c: { get: (k: string) => unknown; env: Env }): Promise<number> {
  const company = c.get("company") as { id: number };
  const row = await c.env.DB.prepare(`SELECT demo FROM companies WHERE id = ?1`).bind(company.id).first<{ demo: number }>();
  return row?.demo ?? 0;
}
function summarizeMsg(m: { status: string; reason?: string } | null) {
  if (!m) return null;
  return { status: m.status, reason: m.reason ?? "" };
}
function fmtLocal(iso: string, tz: string): string {
  return new Date(iso).toLocaleString("pt-BR", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
function waConfirmLink(whatsapp: string, b: Record<string, unknown> | null | undefined, tz: string): string {
  const text = `Olá! Acabei de agendar pelo site: ${b?.service_name} com ${b?.barber_name}, ${fmtLocal(String(b?.starts_at), tz)}. Protocolo ${b?.code}.`;
  return `https://wa.me/${whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

// ── "Meus agendamentos" (protocolo + WhatsApp) ──────────────────────────────
const lookupSchema = z.object({ code: z.string().min(4).max(16), phone: z.string().min(8).max(20) });
publicRouter.get("/bookings/lookup", async (c) => {
  const code = c.req.query("code") || "";
  const phone = c.req.query("phone") || "";
  const s = ctxSettings(c);
  const company = c.get("company") as { id: number };
  const rows = await findPublicBooking(c.env.DB, company.id, code, phone, true);
  if (!rows.length) return err(c, "Nenhum agendamento encontrado com esses dados", 404);
  const nowMs = Date.now();
  return json(c, {
    bookings: rows.map((b) => ({
      ...b,
      starts_local: fmtLocal(String(b.starts_at), s.timezone),
      price: Number(b.price_cents) / 100,
      can_cancel: s.allow_online_cancel && ["pendente", "confirmado"].includes(String(b.status)) && Date.parse(String(b.allowed_cancel_until)) > nowMs,
      can_reschedule: s.allow_online_reschedule && ["pendente", "confirmado"].includes(String(b.status)) && Date.parse(String(b.starts_at)) - nowMs > s.reschedule_cutoff_min * 60000,
      can_check_in: ["pendente","confirmado"].includes(String(b.status))&&!b.checked_in_at &&
        nowMs>=Date.parse(String(b.starts_at))-30*60000 &&
        nowMs<=Date.parse(String(b.ends_at))+30*60000,
    })),
    policy_text: s.cancel_policy_text,
  });
});
publicRouter.post("/bookings/lookup", async (c) => {
  const parsed = lookupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Informe protocolo e WhatsApp", 400);
  const s = ctxSettings(c);
  const company = c.get("company") as { id: number };
  const rows = await findPublicBooking(c.env.DB, company.id, parsed.data.code, parsed.data.phone, true);
  if (!rows.length) return err(c, "Nenhum agendamento encontrado com esses dados", 404);
  const now = Date.now();
  return json(c, {
    bookings: rows.map((b) => ({
      ...b,
      starts_local: fmtLocal(String(b.starts_at), s.timezone),
      price: Number(b.price_cents) / 100,
      can_cancel: s.allow_online_cancel && ["pendente", "confirmado"].includes(String(b.status)) && Date.parse(String(b.allowed_cancel_until)) > now,
      can_reschedule: s.allow_online_reschedule && ["pendente", "confirmado"].includes(String(b.status)) && Date.parse(String(b.starts_at)) - now > s.reschedule_cutoff_min * 60000,
      can_check_in: ["pendente","confirmado"].includes(String(b.status))&&!b.checked_in_at &&
        now>=Date.parse(String(b.starts_at))-30*60000 &&
        now<=Date.parse(String(b.ends_at))+30*60000,
    })),
    policy_text: s.cancel_policy_text,
  });
});

/** O cliente pode anunciar a chegada pelo celular que guardou o token privado
 * da reserva. Código+telefone sozinhos não autorizam o check-in.
 * A origem fica explícita na agenda para conferência presencial da equipe. */
publicRouter.post("/bookings/check-in",async c=>{
 const ip=c.req.header("cf-connecting-ip")||"local";
 const {rateLimit}=await import("../lib/auth");
 if(!await rateLimit(c.env,"client-check-in:"+cid(c)+":"+ip,8,5*60_000))
  return err(c,"Muitas tentativas. Aguarde alguns minutos.",429);
 const parsed=lookupSchema.extend({cancel_token:z.string().uuid()})
  .strict().safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success)return err(c,"Informe protocolo, WhatsApp e código privado da reserva.",422);
 const row=await c.env.DB.prepare(`SELECT id FROM bookings
   WHERE company_id=?1 AND UPPER(code)=?2 AND customer_phone=?3
   AND cancel_token=?4 LIMIT 1`)
  .bind(cid(c),parsed.data.code.trim().toUpperCase(),
    np(parsed.data.phone),parsed.data.cancel_token).first<{id:number}>();
 if(!row)return err(c,"Reserva não encontrada ou código de acesso inválido.",404);
 const result=await markBookingArrived({
  env:c.env,db:c.env.DB,companyId:cid(c),settings:ctxSettings(c),
  origin:"cliente",user:null
 },row.id,new Date(),true);
 if(!result.ok)return err(c,result.message,result.status);
 c.header("Cache-Control","no-store");
 return json(c,{ok:true,checked_in_at:result.checkedInAt,
   message:"Chegada informada ao profissional. Apresente-se para confirmar sua presença."});
});

publicRouter.post("/bookings/cancel", async (c) => {
  const parsed = lookupSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Informe protocolo e WhatsApp", 400);
  const company = c.get("company") as { id: number };
  const s = ctxSettings(c);
  const b = await findPublicBooking(c.env.DB, company.id, parsed.data.code, parsed.data.phone, false);
  if (!b[0]) return err(c, "Agendamento não encontrado", 404);
  const res = await cancelBooking({ env: c.env, db: c.env.DB, companyId: company.id, settings: s, origin: "cliente", user: null }, Number((b[0] as { id: number }).id), { actorRole: "cliente", reason: "cancelado pelo site" });
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true, message: "Agendamento cancelado. O horário foi liberado para novas reservas." });
});

publicRouter.post("/bookings/reschedule", async (c) => {
  const parsed = lookupSchema.extend({ startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 400);
  const company = c.get("company") as { id: number };
  const s = ctxSettings(c);
  const b = await findPublicBooking(c.env.DB, company.id, parsed.data.code, parsed.data.phone, false);
  if (!b[0]) return err(c, "Agendamento não encontrado", 404);
  const res = await rescheduleBooking({ env: c.env, db: c.env.DB, companyId: company.id, settings: s, origin: "cliente", user: null }, Number((b[0] as { id: number }).id), parsed.data.startsAt, "cliente");
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true, starts_at: res.startsAt, starts_local: fmtLocal(res.startsAt, s.timezone), ends_at: res.endsAt });
});

// Acesso individual a partir da mensagem. O token é uma credencial aleatória
// já criada no agendamento: não usar apenas telefone ou protocolo para confirmar.
const actionSchema = z.object({
  code: z.string().min(4).max(32),
  token: z.string().uuid()
}).strict();
async function actionBooking(c: any, value: { code: string; token: string }) {
  return c.env.DB.prepare(
    `SELECT b.id, b.code, b.customer_name, b.starts_at, b.status,
       b.barber_id, b.service_id, br.name AS barber_name, s.name AS service_name
       FROM bookings b
       JOIN barbers br ON br.id=b.barber_id
       JOIN services s ON s.id=b.service_id
       WHERE b.company_id=?1 AND UPPER(b.code)=?2 AND b.cancel_token=?3
       LIMIT 1`
  ).bind(cid(c),value.code.toUpperCase(),value.token).first<{
    id:number;code:string;customer_name:string;starts_at:string;status:string;
    barber_id:number;service_id:number;barber_name:string;service_name:string
  }>();
}
async function actionGuard(c: any) {
  const ip = c.req.header("cf-connecting-ip") || "local";
  const { rateLimit } = await import("../lib/auth");
  return rateLimit(c.env, "booking-wa-action:" + cid(c) + ":" + ip, 25, 5*60_000);
}
publicRouter.post("/bookings/action/lookup", async (c) => {
  if (!await actionGuard(c)) return err(c,"Muitas tentativas. Aguarde alguns minutos.",429);
  const parsed=actionSchema.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success) return err(c,"Link de acesso inválido.",422);
  const b=await actionBooking(c,parsed.data);
  if(!b) return err(c,"Agendamento não encontrado ou link inválido.",404);
  const s=ctxSettings(c);
  const response=await c.env.DB.prepare(
    "SELECT 1 AS ok FROM message_webhook_events WHERE event_uid=?1 AND company_id=?2"
  ).bind("tigu:rsvp:"+b.id,cid(c)).first<{ok:number}>();
  c.header("Cache-Control","no-store");
  return json(c,{
    booking:{code:b.code,customer_name:b.customer_name,starts_at:b.starts_at,
      service_name:b.service_name,barber_name:b.barber_name,
      barber_id:b.barber_id,service_id:b.service_id,status:b.status},
    confirmed_by_customer:!!response,
    can_confirm:["pendente","confirmado"].includes(b.status) &&
      Date.parse(b.starts_at)>Date.now(),
    can_reschedule:s.allow_online_reschedule &&
      ["pendente","confirmado"].includes(b.status) &&
      Date.parse(b.starts_at)-Date.now()>s.reschedule_cutoff_min*60000,
    timezone:s.timezone
  });
});
publicRouter.post("/bookings/action/confirm", async (c) => {
  if(!await actionGuard(c))return err(c,"Muitas tentativas. Aguarde alguns minutos.",429);
  const parsed=actionSchema.safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return err(c,"Link de acesso inválido.",422);
  const b=await actionBooking(c,parsed.data);
  if(!b)return err(c,"Agendamento não encontrado.",404);
  if(!["pendente","confirmado"].includes(b.status) || Date.parse(b.starts_at)<=Date.now())
    return err(c,"Agendamento encerrado ou cancelado.",409);
  // Chave única e escrita atômica: toques repetidos não duplicam a confirmação.
  const inserted=await c.env.DB.prepare(
    `INSERT OR IGNORE INTO message_webhook_events
      (company_id,event_uid,status,raw_json,processed)
      VALUES (?1,?2,'customer_confirmed',?3,1)`
  ).bind(cid(c),"tigu:rsvp:"+b.id,JSON.stringify({booking_code:b.code})).run();
  if(inserted.meta?.changes) {
    await c.env.DB.prepare(
      "INSERT INTO notifications (company_id,audience,title,body,kind) VALUES (?1,'admin','Cliente confirmou agendamento',?2,'message')"
    ).bind(cid(c),b.customer_name+" confirmou sua presença no agendamento "+b.code+".").run();
  }
  c.header("Cache-Control","no-store");
  return json(c,{ok:true,already_confirmed:!inserted.meta?.changes,
    message:"Presença confirmada! Esperamos você no horário agendado."});
});
publicRouter.post("/bookings/action/reschedule", async (c) => {
  if(!await actionGuard(c))return err(c,"Muitas tentativas. Aguarde alguns minutos.",429);
  const parsed=actionSchema.extend({
    startsAt:z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/)
  }).safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return err(c,"Escolha um novo horário disponível.",422);
  const b=await actionBooking(c,parsed.data);
  if(!b)return err(c,"Agendamento não encontrado.",404);
  const res=await rescheduleBooking({
    env:c.env,db:c.env.DB,companyId:cid(c),settings:ctxSettings(c),
    origin:"cliente",user:null
  },b.id,parsed.data.startsAt,"cliente");
  if(!res.ok)return err(c,res.message,res.status);
  c.header("Cache-Control","no-store");
  return json(c,{ok:true,starts_at:res.startsAt,message:"Agendamento remarcado com sucesso."});
});

// avaliação pós-atendimento
publicRouter.post("/reviews", async (c) => {
  const parsed = z.object({ code: z.string().min(4), phone: z.string().min(8), rating: z.number().int().min(1).max(5), comment: z.string().max(500).default("") }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 400);
  const s = ctxSettings(c);
  if (!s.reviews_enabled) return err(c, "Avaliações estão desativadas", 403);
  const company = c.get("company") as { id: number };
  const b = await findPublicBooking(c.env.DB, company.id, parsed.data.code, parsed.data.phone, false);
  if (!b[0]) return err(c, "Agendamento não encontrado", 404);
  const booking = b[0] as { id: number; status: string; customer_name: string; barber_id: number };
  if (booking.status !== "concluido") return err(c, "Só é possível avaliar atendimentos concluídos", 409);
  const dup = await c.env.DB.prepare(`SELECT id FROM reviews WHERE booking_id = ?1`).bind(booking.id).first();
  if (dup) return err(c, "Este atendimento já foi avaliado", 409);
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO reviews (company_id, barber_id, booking_id, customer_name, rating, comment, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)`).bind(company.id, booking.barber_id, booking.id, String(booking.customer_name).split(" ")[0], parsed.data.rating, parsed.data.comment.trim(), nowIso()),
    c.env.DB.prepare(`UPDATE barbers SET rating = (SELECT ROUND(AVG(rating),2) FROM reviews WHERE barber_id = ?1), reviews_count = (SELECT COUNT(*) FROM reviews WHERE barber_id = ?1) WHERE id = ?1`).bind(booking.barber_id),
  ]);
  return json(c, { ok: true, message: "Obrigado pela avaliação!" }, 201);
});

// ── Loja: catálogo + pedido (retirada no balcão / pagamento via WhatsApp) ───
publicRouter.get("/products", async (c) => {
  const company = c.get("company") as { id: number };
  const s = ctxSettings(c);
  if (!s.products_enabled) return json(c, { products: [] });
  const { results } = await c.env.DB.prepare(`SELECT id, slug, name, description, price_cents, category, photo, stock FROM products WHERE company_id = ?1 AND active = 1 ORDER BY featured DESC, name`).bind(company.id).all();
  return json(c, { products: results.map((p: Record<string, unknown>) => ({ ...p, price: Number(p.price_cents) / 100 })) });
});

publicRouter.post("/orders",async c=>{
 const settings=ctxSettings(c);
 if(!settings.products_enabled)return err(c,"Loja desativada",403);
 const parsed=z.object({
  name:z.string().min(2).max(90),phone:z.string().min(8).max(20),
  email:z.string().email().or(z.literal("")).optional(),
  paymentChoice:z.enum(["after_service","pix"]).optional(),
  idempotencyKey:z.string().min(8).max(64).optional(),
  items:z.array(z.object({productId:z.number().int().positive(),
   qty:z.number().int().min(1).max(20)})).min(1).max(20)
 }).safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success)return err(c,"Dados inválidos",422);
 const companyId=cid(c),db=c.env.DB,choice=parsed.data.paymentChoice??"after_service";
 if(choice==="pix"&&!(await merchantPixReady(c.env,companyId)))
  return err(c,"Esta barbearia não habilitou Pix. Selecione pagamento na retirada.",503);
 if(choice==="pix"&&!parsed.data.email)return err(c,"Informe e-mail para gerar Pix.",422);
 const key=parsed.data.idempotencyKey||crypto.randomUUID(),phone=normalizePhone(parsed.data.phone);
 const previous=await db.prepare("SELECT id,code,status,total_cents,payment_choice FROM orders WHERE company_id=?1 AND checkout_key=?2")
  .bind(companyId,key).first<{id:number;code:string;status:string;total_cents:number;payment_choice:string}>();
 if(previous)return respond(previous);
 const ids=parsed.data.items.map(it=>it.productId);
 if(new Set(ids).size!==ids.length)return err(c,"Produtos repetidos no mesmo pedido.",409);
 const placeholders=ids.map((_,i)=>"?"+(i+2)).join(",");
 const prods=await db.prepare("SELECT id,name,price_cents,stock,active FROM products WHERE company_id=?1 AND id IN ("+placeholders+")")
  .bind(companyId,...ids).all<{id:number;name:string;price_cents:number;stock:number;active:number}>();
 const stock=new Map(prods.results.map(p=>[p.id,p]));let total=0;
 for(const item of parsed.data.items){
  const product=stock.get(item.productId);
  if(!product||!product.active||!Number.isSafeInteger(product.price_cents)||product.price_cents<=0)
   return err(c,"Produto indisponível",409);
  if(product.stock<item.qty)return err(c,"Estoque insuficiente de "+product.name,409);
  total+=product.price_cents*item.qty;
 }
 const code="PED-"+Array.from(crypto.getRandomValues(new Uint8Array(4)))
  .map(b=>b.toString(36).padStart(2,"0")).join("").toUpperCase().slice(0,7);
 const at=nowIso();
 try {
  await db.batch([
   db.prepare("INSERT INTO orders(company_id,code,customer_name,customer_phone,customer_email,checkout_key,payment_choice,channel,status,total_cents,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'online','novo',?8,?9,?9)")
    .bind(companyId,code,parsed.data.name.trim(),phone,parsed.data.email||null,key,choice,total,at),
   ...parsed.data.items.map(it=>db.prepare("INSERT INTO order_items(order_id,product_id,product_name,qty,unit_price_cents) SELECT id,?1,?2,?3,?4 FROM orders WHERE code=?5 AND company_id=?6")
    .bind(it.productId,stock.get(it.productId)!.name,it.qty,stock.get(it.productId)!.price_cents,code,companyId)),
   ...parsed.data.items.map(it=>db.prepare("UPDATE products SET stock=stock-?1 WHERE id=?2 AND company_id=?3")
    .bind(it.qty,it.productId,companyId)),
   ...parsed.data.items.map(it=>db.prepare("INSERT INTO stock_movements(company_id,product_id,delta,reason,ref,created_at) VALUES (?1,?2,-?3,'pedido',?4,?5)")
    .bind(companyId,it.productId,it.qty,code,at)),
   db.prepare("INSERT INTO notifications(company_id,audience,title,body,kind) VALUES (?1,'admin','Novo pedido da loja',?2,'order')")
    .bind(companyId,parsed.data.name+" • "+brl(total)+" • "+code)
  ]);
 }catch{
  const saved=await db.prepare("SELECT id,code,status,total_cents,payment_choice FROM orders WHERE company_id=?1 AND checkout_key=?2")
   .bind(companyId,key).first<{id:number;code:string;status:string;total_cents:number;payment_choice:string}>();
  if(saved)return respond(saved);
  return err(c,"Não foi possível registrar pedido (estoque alterado?).",409);
 }
 const created=await db.prepare("SELECT id,code,status,total_cents,payment_choice FROM orders WHERE company_id=?1 AND checkout_key=?2")
  .bind(companyId,key).first<{id:number;code:string;status:string;total_cents:number;payment_choice:string}>();
 if(!created)return err(c,"Não foi possível encontrar o pedido.",503);
 return respond(created);

 async function respond(order:{id:number;code:string;status:string;total_cents:number;payment_choice:string}){
  if(order.payment_choice!==choice)return err(c,"Chave de pedido pertence a outra escolha de pagamento.",409);
  const result=choice==="pix"?await generateOrderPix(c.env,companyId,order.id):null;
  const wa=settings.whatsapp?"https://wa.me/"+settings.whatsapp.replace(/\D/g,"")+"?text="+
   encodeURIComponent("Olá! Fiz o pedido "+order.code+" na loja ("+brl(order.total_cents)+")."):null;
  return json(c,{ok:true,code:order.code,total:order.total_cents/100,payment_choice:choice,
   payment:result?.payment??null,payment_token:result?.lookup_token??null,whatsapp_link:wa},201);
 }
});
publicRouter.post("/orders/pix/status",async c=>{
 const parsed=z.object({code:z.string().min(4).max(32),
  phone:z.string().min(8).max(20),payment_token:z.string().uuid()})
  .safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success)return err(c,"Dados inválidos",422);
 const {rateLimit}=await import("../lib/auth");
 const ip=c.req.header("cf-connecting-ip")||"local";
 if(!(await rateLimit(c.env,"order-pix-status:"+ip,15,300000)))return err(c,"Limite de consultas.",429);
 const payment=await lookupOrderPix(c.env,cid(c),parsed.data.code,parsed.data.phone,parsed.data.payment_token);
 if(!payment)return err(c,"Pedido ou pagamento não encontrado",404);
 return json(c,{payment});
});
