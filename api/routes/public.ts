// ============================================================================
// Rotas PÚBLICAS por empresa: /api/c/:slug/... — site, agenda, reservas do
// cliente (lookup/cancelar/remarcar), loja. Isolamento: toda query usa o
// company_id resolvido no servidor a partir do slug.
// ============================================================================
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { err, json, normalizePhone, nowIso, brl } from "../lib/utils";
import { cid, ctxSettings, tenantMiddleware } from "../lib/tenant";
import { computeDaySlots, monthSummary, type BarberRow, type ServiceRow } from "../lib/availability";
import { createBooking, createBookingSchema, cancelBooking, rescheduleBooking } from "../lib/booking";
import { normalizePhone as np } from "../lib/utils";

async function findPublicBooking(db: D1Database, companyId: number, code: string, phone: string, listAll: boolean) {
  const tail = listAll ? " ORDER BY b.starts_at DESC LIMIT 10" : " ORDER BY b.starts_at DESC LIMIT 1";
  const where = `WHERE b.company_id = ?1 AND UPPER(b.code) = ?2 AND b.customer_phone = ?3`;
  const { results } = await db
    .prepare(
      `SELECT b.id, b.code, b.status, b.starts_at, b.ends_at, b.price_cents, b.notes, b.allowed_cancel_until, b.barber_id, b.customer_name,
              s.name AS service_name, s.duration_min, br.name AS barber_name, br.photo AS barber_photo
       FROM bookings b JOIN services s ON s.id = b.service_id JOIN barbers br ON br.id = b.barber_id
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
  return json(c, { settings: { ...ctxSettings(c) }, demo_active: co?.demo === 1 });
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
  return json(c, { barber });
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
  const company = c.get("company") as { id: number };
  const res = await createBooking(
    { env: c.env, db: c.env.DB, companyId: company.id, settings: s, origin: "cliente", user: null, demo: await demoFlag(c) },
    parsed.data
  );
  if (!res.ok) return err(c, res.message, res.status, res.issues);
  const db = c.env.DB;
  const b = await db.prepare(`SELECT b.*, s.name AS service_name, br.name AS barber_name FROM bookings b JOIN services s ON s.id=b.service_id JOIN barbers br ON br.id=b.barber_id WHERE b.id = ?1`).bind(res.bookingId).first<Record<string, unknown>>();
  return json(c, {
    booking: { ...(b ?? {}), starts_local: fmtLocal(String(res.startsAt), s.timezone), price: Number(b?.price_cents ?? 0) / 100 },
    cancel_token: res.cancelToken,
    allowed_cancel_until: res.allowedCancelUntil,
    policy: { allow_online_cancel: s.allow_online_cancel, allow_online_reschedule: s.allow_online_reschedule, cancel_cutoff_min: s.cancel_cutoff_min, reschedule_cutoff_min: s.reschedule_cutoff_min, cancel_policy_text: s.cancel_policy_text },
    messaging: { reminder: summarizeMsg(res.messaging), confirmation: summarizeMsg(res.confirmMessaging) },
    whatsapp_link: s.whatsapp ? waConfirmLink(s.whatsapp, b, s.timezone) : null,
  }, 201);
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
    })),
    policy_text: s.cancel_policy_text,
  });
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

publicRouter.post("/orders", async (c) => {
  const s = ctxSettings(c);
  if (!s.products_enabled) return err(c, "Loja desativada", 403);
  const parsed = z
    .object({ name: z.string().min(2).max(90), phone: z.string().min(8).max(20), items: z.array(z.object({ productId: z.number().int().positive(), qty: z.number().int().min(1).max(20) })).min(1).max(20) })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422);
  const company = c.get("company") as { id: number };
  const db = c.env.DB;
  const ids = parsed.data.items.map((i) => i.productId);
  const ph = ids.map((_, i) => `?${i + 2}`).join(",");
  const prods = await db.prepare(`SELECT id, name, price_cents, stock, active FROM products WHERE company_id = ?1 AND id IN (${ph})`).bind(company.id, ...ids).all<{ id: number; name: string; price_cents: number; stock: number; active: number }>();
  const map = new Map(prods.results.map((p) => [p.id, p]));
  let total = 0;
  for (const it of parsed.data.items) {
    const p = map.get(it.productId);
    if (!p || !p.active) return err(c, "Produto indisponível", 409);
    if (p.stock < it.qty) return err(c, `Estoque insuficiente de "${p.name}" (restam ${p.stock})`, 409);
    total += p.price_cents * it.qty;
  }
  const code = `PED-${Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(36).padStart(2, "0").replace(/[^a-z0-9]/gi, "")).join("").toUpperCase().slice(0, 7)}`;
  const phone = normalizePhone(parsed.data.phone);
  try {
    await db.batch([
      db.prepare(`INSERT INTO orders (company_id, code, customer_name, customer_phone, channel, status, total_cents, created_at, updated_at) VALUES (?1,?2,?3,?4,'online','novo',?5,?6,?6)`).bind(company.id, code, parsed.data.name.trim(), phone, total, nowIso()),
      ...parsed.data.items.map((it) =>
        db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, qty, unit_price_cents) SELECT id, ?1, ?2, ?3, ?4 FROM orders WHERE code = ?5`).bind(it.productId, map.get(it.productId)!.name, it.qty, map.get(it.productId)!.price_cents, code)
      ),
      ...parsed.data.items.map((it) => db.prepare(`UPDATE products SET stock = stock - ?1 WHERE id = ?2 AND company_id = ?3`).bind(it.qty, it.productId, company.id)),
      ...parsed.data.items.map((it) => db.prepare(`INSERT INTO stock_movements (company_id, product_id, delta, reason, ref, created_at) VALUES (?1,?2,-?3,'pedido',?4,?5)`).bind(company.id, it.productId, it.qty, code, nowIso())),
      db.prepare(`INSERT INTO notifications (company_id, audience, title, body, kind) VALUES (?1,'admin','Novo pedido da loja',?2,'order')`).bind(company.id, `${parsed.data.name} • ${parsed.data.items.length} item(ns) • ${brl(total)} • pedido ${code}`),
    ]);
  } catch (e) {
    return err(c, "Não foi possível registrar o pedido (estoque mudou?). Tente novamente.", 409);
  }
  const wa = s.whatsapp ? `https://wa.me/${s.whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(`Olá! Fiz o pedido ${code} na loja on-line (${brl(total)}). Pode confirmar?`)}` : null;
  return json(c, { ok: true, code, total: total / 100, whatsapp_link: wa }, 201);
});
