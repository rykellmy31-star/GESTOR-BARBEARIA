// ============================================================================
// Painel da BARBEARIA (dono/gerente) — /api/c/:slug/admin/...
// RBAC aplicado no middleware (membership verificada). Tudo escopado por
// company_id. Financeiro: leitura; mutações só via lib/topup & lib/wallet.
// ============================================================================
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { err, json, nowIso, uniqueSlug, slugify, brl, normalizePhone } from "../lib/utils";
import { cid, ctxSettings, tenantMiddleware } from "../lib/tenant";
import { createBooking, createBookingSchema, cancelBooking, rescheduleBooking, setBookingStatus } from "../lib/booking";
import { assertSlotAllowed, slotKeysFor, type BarberRow, type ServiceRow } from "../lib/availability";
import { companySettingsSchema, saveCompanySettings } from "../lib/settings";
import { audit } from "../lib/audit";
import { hashPassword } from "../lib/crypto";
import { changeOrderStatus } from "../lib/orders";
import { createTeamAccount } from "../lib/team-accounts";
import { updateTeamAccess, type TeamMemberSnapshot } from "../lib/team-access";
import { IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, hasImageSignature, readUploadBody } from "../lib/image-upload";
import { resolveBlockRequest } from "../lib/block-requests";
import { barberCapacitySql } from "../lib/barber-capacity";
import { calendarDaySchema, intervalBlockSchema, createAdminIntervalBlock, dayBlockSchema, createAdminDayBlock } from "../lib/admin-blocks";
import { barberScheduleFields, barberScheduleSchema } from "../lib/schedule-validation";
import { getWallet, manualAdjustment } from "../lib/wallet";
import { createTopup, confirmTopupFromProvider, getTopupLimits } from "../lib/topup";
import { getConnection, sendImmediate, resolvePricing, processDueJobs } from "../lib/messaging/jobs";
import { resolveProvider, exchangeEmbeddedSignupCode, mockAllowed } from "../lib/messaging/provider";
import { pickPaymentProvider } from "../lib/payments";
import { merchantStatus, configureMerchant, disconnectMerchant } from "../lib/merchant-payments";
import { todayLocal, addDays, formatDayPtBr } from "../lib/time";

export const adminRouter = new Hono<{ Bindings: Env }>();
adminRouter.use("*", tenantMiddleware({ auth: "admin" }));

const P = (c: { env: Env }) => c.env.DB;

// ── dashboard ────────────────────────────────────────────────────────────────
adminRouter.get("/dashboard", async (c) => {
  const db = P(c);
  const id = cid(c);
  const s = ctxSettings(c);
  const tz = s.timezone;
  const today = todayLocal(tz);
  const from = c.req.query("from") || today;
  const to = c.req.query("to") || today;
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  if (!dayRe.test(from) || !dayRe.test(to)) return err(c, "Período inválido", 400);
  const { localToUtc, utcToLocal, addDays: addDaysStr, formatHHMM } = await import("../lib/time");
  const { computeDaySlots } = await import("../lib/availability");
  const dayStartUtc = localToUtc(tz, from, 0).toISOString().replace(/\.\d{3}Z$/, "Z");
  const dayEndUtc = localToUtc(tz, to, 24 * 60 - 1).toISOString().replace(/\.\d{3}Z$/, "Z");

  const statusRows = await db.prepare(`SELECT status, COUNT(*) AS n FROM bookings WHERE company_id=?1 AND starts_at >= ?2 AND starts_at <= ?3 GROUP BY status`).bind(id, dayStartUtc, dayEndUtc).all<{ status: string; n: number }>();
  const byStatus: Record<string, number> = {};
  for (const r of statusRows.results) byStatus[r.status] = r.n;

  const totals = await db.prepare(
    `SELECT
      (SELECT COUNT(*) FROM bookings WHERE company_id=?1 AND starts_at >= ?2 AND starts_at <= ?3) AS period_total,
      (SELECT COALESCE(SUM(price_cents),0) FROM bookings WHERE company_id=?1 AND status='concluido' AND starts_at >= ?2 AND starts_at <= ?3) AS revenue_bookings,
      (SELECT COALESCE(SUM(price_cents),0) FROM bookings WHERE company_id=?1 AND status IN ('pendente','confirmado') AND starts_at >= ?4) AS forecast,
      (SELECT COUNT(*) FROM customers WHERE company_id=?1) AS customers,
      (SELECT COUNT(*) FROM barbers WHERE company_id=?1 AND active=1) AS active_barbers,
      (SELECT COALESCE(SUM(oi.qty),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.company_id=?1 AND o.status IN ('pago','entregue') AND o.created_at >= ?2 AND o.created_at <= ?3) AS units_sold,
      (SELECT COALESCE(SUM(oi.qty*oi.unit_price_cents),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.company_id=?1 AND o.status IN ('pago','entregue') AND o.created_at >= ?2 AND o.created_at <= ?3) AS revenue_products,
      (SELECT COUNT(*) FROM orders WHERE company_id=?1 AND status='novo') AS open_orders`
  ).bind(id, dayStartUtc, dayEndUtc, nowIso()).first<Record<string, number>>();

  const seriesRows = await db.prepare(`SELECT status, starts_at, price_cents FROM bookings WHERE company_id=?1 AND starts_at >= ?2 AND starts_at <= ?3`).bind(id, dayStartUtc, dayEndUtc).all<{ status: string; starts_at: string; price_cents: number }>();
  const seriesMap = new Map<string, { day: string; bookings: number; revenue: number }>();
  for (let d = from; d <= to && seriesMap.size < 62; d = addDaysStr(d, 1)) seriesMap.set(d, { day: d, bookings: 0, revenue: 0 });
  for (const r of seriesRows.results) {
    const { day } = utcToLocal(tz, r.starts_at);
    const rec = seriesMap.get(day);
    if (!rec) continue;
    if (["pendente", "confirmado", "concluido", "no_show"].includes(r.status)) rec.bookings++;
    if (r.status === "concluido") rec.revenue += r.price_cents;
  }

  const barbers = await db.prepare(`SELECT id, name, photo, work_days, work_start, work_end, break_start, break_end, active FROM barbers WHERE company_id=?1 AND active=1 ORDER BY sort, id`).bind(id).all<BarberRow & { name: string; photo: string }>();
  const availByBarber: { barber_id: number; name: string; available_today: number }[] = [];
  for (const b of barbers.results) {
    const svc = await db.prepare(`SELECT s.id, s.name, s.duration_min, s.price_cents FROM services s JOIN service_barbers sb ON sb.service_id=s.id WHERE sb.barber_id=?1 AND s.company_id=?2 AND s.active=1 ORDER BY s.duration_min ASC LIMIT 1`).bind(b.id, id).first<ServiceRow>();
    if (!svc) { availByBarber.push({ barber_id: b.id, name: b.name, available_today: 0 }); continue; }
    const res = await computeDaySlots(db, { barber: b, service: svc, day: today, settings: s, mode: "public" });
    availByBarber.push({ barber_id: b.id, name: b.name, available_today: res.slots.length });
  }

  const upcomingRows = await db.prepare(
    `SELECT b.id, b.code, b.status, b.starts_at, b.price_cents, b.customer_name, s.name AS service_name, br.name AS barber_name
     FROM bookings b JOIN services s ON s.id=b.service_id JOIN barbers br ON br.id=b.barber_id
     WHERE b.company_id=?1 AND b.status IN ('pendente','confirmado') AND b.starts_at >= ?2 ORDER BY b.starts_at ASC LIMIT 8`
  ).bind(id, nowIso()).all();

  const wallet = await getWallet(db, id);
  const conn = await getConnection(db, id);
  return json(c, {
    period: { from, to },
    kpis: {
      total_today: totals?.period_total ?? 0,
      today_label: from === today && to === today ? "hoje" : `${from} a ${to}`,
      pending: byStatus.pendente ?? 0,
      confirmed: byStatus.confirmado ?? 0,
      canceled: byStatus.cancelado ?? 0,
      completed: byStatus.concluido ?? 0,
      no_show: byStatus.no_show ?? 0,
      customers: totals?.customers ?? 0,
      active_barbers: totals?.active_barbers ?? 0,
      revenue_realized_cents: (totals?.revenue_bookings ?? 0) + (totals?.revenue_products ?? 0),
      revenue_bookings_cents: totals?.revenue_bookings ?? 0,
      revenue_products_cents: totals?.revenue_products ?? 0,
      revenue_forecast_cents: totals?.forecast ?? 0,
      units_sold: totals?.units_sold ?? 0,
      open_orders: totals?.open_orders ?? 0,
      available_today: availByBarber.reduce((a, x) => a + x.available_today, 0),
    },
    availability_by_barber: availByBarber,
    series: [...seriesMap.values()].map((x) => ({ ...x, revenue: x.revenue / 100 })),
    upcoming: upcomingRows.results,
    wallet: wallet ? { balance_cents: wallet.balance_cents, reserved_cents: wallet.reserved_cents, available_cents: wallet.balance_cents - wallet.reserved_cents } : null,
    whatsapp: conn ? { status: conn.status, provider: conn.provider, display_phone: conn.display_phone } : { status: "disconnected", provider: "meta_cloud" },
  });
});

/* Agenda visual: dia / semana / mês (matriz dias × barbeiros + bloqueios) */
adminRouter.get("/agenda", async (c) => {
  const db = P(c);
  const s = ctxSettings(c);
  const id = cid(c);
  const { localToUtc, utcToLocal, addDays: addDaysStr, formatHHMM } = await import("../lib/time");
  const tz = s.timezone;
  const today = todayLocal(tz);
  const view = (c.req.query("view") || "day") as "day" | "week" | "month";
  const date = c.req.query("date") || today;
  const barberId = c.req.query("barberId") ? Number(c.req.query("barberId")) : null;
  const q = (c.req.query("q") || "").trim().toLowerCase();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return err(c, "Data inválida", 400);
  const [yy, mm, dd] = date.split("-").map(Number);
  const base = new Date(Date.UTC(yy, mm - 1, dd));
  let from = date, to = date;
  if (view === "week") { from = addDaysStr(date, -base.getUTCDay()); to = addDaysStr(from, 6); }
  if (view === "month") {
    from = `${yy}-${String(mm).padStart(2, "0")}-01`;
    const lastDay = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
    to = `${yy}-${String(mm).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  }
  const startUtc = localToUtc(tz, from, 0).toISOString().replace(/\.\d{3}Z$/, "Z");
  const endUtc = localToUtc(tz, to, 24 * 60 - 1).toISOString().replace(/\.\d{3}Z$/, "Z");
  const where: string[] = ["b.company_id = ?1", "b.starts_at >= ?2", "b.starts_at <= ?3"];
  const binds: unknown[] = [id, startUtc, endUtc];
  if (barberId) { where.push("b.barber_id = ?4"); binds.push(barberId); }
  const rows = await db.prepare(
    `SELECT b.id, b.code, b.status, b.origin, b.starts_at, b.ends_at, b.price_cents, b.customer_name, b.customer_phone, b.notes,
            s.name AS service_name, s.duration_min, br.id AS barber_id, br.name AS barber_name, br.photo AS barber_photo
     FROM bookings b JOIN barbers br ON br.id=b.barber_id AND br.company_id=?1 LEFT JOIN services s ON s.id=b.service_id
     WHERE ${where.join(" AND ")} ORDER BY b.starts_at ASC`
  ).bind(...(binds as never[])).all<Record<string, unknown>>();
  const blocked = await db.prepare(
    `SELECT bd.id, bd.barber_id, bd.date_from, bd.date_to, bd.kind, bd.reason, br.name AS barber_name
     FROM blocked_days bd LEFT JOIN barbers br ON br.id = bd.barber_id
     WHERE bd.company_id=?1 AND bd.date_from <= ?2 AND bd.date_to >= ?3`
  ).bind(id, to, from).all<Record<string, unknown>>();

  const dayMap = new Map<string, Map<number, unknown[]>>();
  const barbersOnDay = new Map<number, { barber_id: number; name: string; photo: string }>();
  for (const r of rows.results) {
    if (q) { const hay = `${r.code} ${r.customer_name} ${r.customer_phone}`.toLowerCase(); if (!hay.includes(q)) continue; }
    const { day, minutes } = utcToLocal(tz, String(r.starts_at));
    if (!dayMap.has(day)) dayMap.set(day, new Map());
    const perBarber = dayMap.get(day)!;
    const bid = r.barber_id as number;
    perBarber.set(bid, [...(perBarber.get(bid) || []), { ...r, minutes, label: formatHHMM(minutes), price: Number(r.price_cents) / 100, duration_label: `${r.duration_min ?? 0} min` }]);
    barbersOnDay.set(bid, { barber_id: bid, name: String(r.barber_name), photo: String(r.barber_photo ?? "") });
  }
  const days: unknown[] = [];
  for (let d = from; d <= to && days.length < 62; d = addDaysStr(d, 1)) {
    const perBarber = dayMap.get(d) || new Map<number, unknown[]>();
    const { weekday } = utcToLocal(tz, new Date(`${d}T12:00:00Z`));
    const ids = [...new Set([...perBarber.keys(), ...(barberId ? [] : [...barbersOnDay.keys()])])].filter((i) => (barberId ? i === barberId : true)).sort((a, b2) => a - b2);
    days.push({
      date: d,
      weekday,
      barbers: ids.map((bi) => ({ ...(barbersOnDay.get(bi) ?? { barber_id: bi, name: `#${bi}`, photo: "" }), items: [...(perBarber.get(bi) || [])].sort((a, b2) => (a as { minutes: number }).minutes - (b2 as { minutes: number }).minutes) })),
      blocked: blocked.results.filter((b) => String(b.date_from) <= d && String(b.date_to) >= d && (barberId ? b.barber_id === barberId || b.barber_id === null : true)),
    });
  }
  return json(c, { view, range: { from, to }, today, days });
});

adminRouter.get("/reports", async (c) => {
  const db = P(c);
  const id = cid(c);
  const from = c.req.query("from") || addDays(todayLocal(ctxSettings(c).timezone), -29);
  const to = c.req.query("to") || todayLocal(ctxSettings(c).timezone);
  const a = new Date(`${from}T00:00:00Z`).toISOString();
  const b = new Date(`${addDays(to, 1)}T00:00:00Z`).toISOString();
  const [days, byService, byBarber, funnel, messages] = await Promise.all([
    db.prepare(`SELECT date(starts_at) AS day, COUNT(*) AS n, SUM(CASE WHEN status='concluido' THEN price_cents ELSE 0 END) AS revenue_cents,
                       SUM(CASE WHEN status='cancelado' THEN 1 ELSE 0 END) AS cancels
                FROM bookings WHERE company_id=?1 AND starts_at>=?2 AND starts_at<?3 GROUP BY day ORDER BY day`).bind(id, a, b).all(),
    db.prepare(`SELECT s.name, COUNT(*) n, SUM(b.price_cents) revenue_cents FROM bookings b JOIN services s ON s.id=b.service_id
                WHERE b.company_id=?1 AND b.status IN ('concluido','confirmado','pendente') AND b.starts_at>=?2 AND b.starts_at<?3 GROUP BY s.name ORDER BY revenue_cents DESC`).bind(id, a, b).all(),
    db.prepare(`SELECT br.name, COUNT(*) n, SUM(CASE WHEN b.status='concluido' THEN b.price_cents ELSE 0 END) revenue_cents FROM bookings b JOIN barbers br ON br.id=b.barber_id
                WHERE b.company_id=?1 AND b.starts_at>=?2 AND b.starts_at<?3 AND b.status!='bloqueio' GROUP BY br.name ORDER BY revenue_cents DESC`).bind(id, a, b).all(),
    db.prepare(`SELECT status, COUNT(*) n FROM bookings WHERE company_id=?1 AND starts_at>=?2 AND starts_at<?3 GROUP BY status`).bind(id, a, b).all(),
    db.prepare(`SELECT COUNT(*) total, SUM(CASE WHEN status IN ('sent','delivered','read') THEN 1 ELSE 0 END) sent,
                       SUM(CASE WHEN captured_at IS NOT NULL THEN price_cents ELSE 0 END) charged_cents,
                       SUM(CASE WHEN captured_at IS NOT NULL THEN cost_cents ELSE 0 END) est_cost_cents
                FROM message_jobs WHERE company_id=?1 AND created_at>=?2 AND created_at<?3`).bind(id, a, b).first(),
  ]);
  return json(c, { from, to, days: days.results, by_service: byService.results, by_barber: byBarber.results, funnel: funnel.results, messages });
});

// ── agenda ───────────────────────────────────────────────────────────────────
adminRouter.get("/bookings", async (c) => {
  const from = c.req.query("from") || todayLocal(ctxSettings(c).timezone);
  const to = c.req.query("to") || addDays(from, 6);
  const { results } = await P(c)
    .prepare(
      `SELECT b.*, s.name AS service_name, br.name AS barber_name, bp.status AS payment_status FROM bookings b
       LEFT JOIN services s ON s.id=b.service_id JOIN barbers br ON br.id=b.barber_id
       LEFT JOIN booking_payments bp ON bp.booking_id=b.id AND bp.company_id=b.company_id
       WHERE b.company_id=?1 AND b.starts_at>=?2 AND b.starts_at<?3 AND b.status!='bloqueio' ORDER BY b.starts_at`
    )
    .bind(cid(c), new Date(`${from}T00:00:00Z`).toISOString(), new Date(`${addDays(to, 1)}T00:00:00Z`).toISOString())
    .all();
  return json(c, { bookings: results });
});

adminRouter.post("/bookings", async (c) => {
  const parsed = createBookingSchema.omit({ consent: true }).partial({ idempotencyKey: true }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const input = { consent: true, idempotencyKey: `admin-${crypto.randomUUID()}`, ...parsed.data, paymentChoice: "after_service" } as z.infer<typeof createBookingSchema>;
  const res = await createBooking(
    { env: c.env, db: P(c), companyId: cid(c), settings: ctxSettings(c), origin: "admin", user: c.get("user"), demo: 0 },
    input
  );
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true, id: res.bookingId, code: res.code, messaging: res.messaging }, 201);
});

const bookingIdParam = async (c: { req: { param: (k: string) => string | undefined } }) => parseInt(c.req.param("id") || "0", 10);

adminRouter.put("/bookings/:id/status", async (c) => {
  const parsed = z.object({ status: z.enum(["confirmado", "concluido", "no_show"]) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Status inválido", 400);
  const res = await setBookingStatus({ env: c.env, db: P(c), companyId: cid(c), settings: ctxSettings(c), origin: "admin", user: c.get("user") }, await bookingIdParam(c), parsed.data.status);
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true });
});

adminRouter.post("/bookings/:id/cancel", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const res = await cancelBooking({ env: c.env, db: P(c), companyId: cid(c), settings: ctxSettings(c), origin: "admin", user: c.get("user") }, await bookingIdParam(c), { actorRole: "admin", reason: body.reason ?? "" });
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true });
});

adminRouter.post("/bookings/:id/reschedule", async (c) => {
  const parsed = z.object({ startsAt: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "startsAt obrigatório", 400);
  const res = await rescheduleBooking({ env: c.env, db: P(c), companyId: cid(c), settings: ctxSettings(c), origin: "admin", user: c.get("user") }, await bookingIdParam(c), parsed.data.startsAt, "admin");
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true, starts_at: res.startsAt, ends_at: res.endsAt });
});

adminRouter.get("/availability", async (c) => {
  const barberId = Number(c.req.query("barberId"));
  const serviceId = Number(c.req.query("serviceId"));
  const day = c.req.query("day") || todayLocal(ctxSettings(c).timezone);
  const db = P(c);
  const barber = await db.prepare(`SELECT id, name, work_days, work_start, work_end, break_start, break_end, active FROM barbers WHERE id=?1 AND company_id=?2`).bind(barberId, cid(c)).first<BarberRow>();
  if (!barber) return err(c, "Barbeiro inválido", 404);
  const service = await db.prepare(`SELECT id, name, duration_min, price_cents FROM services WHERE id=?1 AND company_id=?2`).bind(serviceId, cid(c)).first();
  if (!service) return err(c, "Serviço inválido", 404);
  const { computeDaySlots } = await import("../lib/availability");
  return json(c, await computeDaySlots(db, { barber, service: service as never, day, settings: ctxSettings(c), mode: "admin" }));
});

// bloqueios de agenda (day-off e horários)
adminRouter.post("/bookings/block", async (c) => {
  const parsed = z
    .object({
      barberId: z.number().int().positive().nullable().optional(),
      day: calendarDaySchema,
      endDay: calendarDaySchema.optional(),
      startMin: z.number().int().min(0).max(1439).optional(),
      endMin: z.number().int().min(1).max(1440).optional(),
      reason: z.string().max(200).default("Bloqueio da administração"),
    })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 400);
  const db = P(c);
  const id = cid(c);
  const s = ctxSettings(c);
  const day = parsed.data.day;
  const endDay = parsed.data.endDay || day;
  if ((parsed.data.startMin == null) !== (parsed.data.endMin == null)) return err(c,"Informe início e fim juntos",400);
  if (parsed.data.startMin != null && parsed.data.endMin != null) {
    if (endDay !== day) return err(c,"O bloqueio de horário deve terminar no mesmo dia",400);
    const barberId = parsed.data.barberId ?? (await db.prepare("SELECT id FROM barbers WHERE company_id=?1 AND active=1 ORDER BY id LIMIT 1").bind(id).first<{id:number}>())?.id;
    const interval=intervalBlockSchema.safeParse({...parsed.data,barberId,date:day});
    if (!interval.success) return err(c,"Intervalo inválido",400,interval.error.flatten().fieldErrors);
    const result=await createAdminIntervalBlock(db,id,s.timezone,interval.data);
    if (!result.ok) return err(c,result.message,result.status);
    return json(c,result,201);
  }
  const days=dayBlockSchema.safeParse({barberId:parsed.data.barberId??null,dateFrom:day,dateTo:endDay,kind:"other",reason:parsed.data.reason});
  if (!days.success) return err(c,"Período inválido",422,days.error.flatten().fieldErrors);
  const result=await createAdminDayBlock(db,id,days.data);
  if (!result.ok) return err(c,result.message,result.status);
  return json(c,result,201);
});

adminRouter.delete("/blocked-days/:id", async (c) => {
  await P(c).prepare(`DELETE FROM blocked_days WHERE id = ?1 AND company_id = ?2`).bind(await bookingIdParam(c), cid(c)).run();
  return json(c, { ok: true });
});
adminRouter.get("/blocked-days", async (c) => {
  const { results } = await P(c).prepare(`SELECT bd.*, br.name AS barber_name FROM blocked_days bd LEFT JOIN barbers br ON br.id=bd.barber_id WHERE bd.company_id=?1 AND bd.date_to>=?2 ORDER BY bd.date_from DESC LIMIT 100`).bind(cid(c), todayLocal(ctxSettings(c).timezone)).all();
  return json(c, { blocked: results, blocked_days: results });
});

adminRouter.get("/block-requests", async (c) => {
  const { results } = await P(c).prepare(`SELECT br2.*, b.name AS barber_name FROM block_requests br2 JOIN barbers b ON b.id = br2.barber_id WHERE br2.company_id=?1 ORDER BY br2.status='pendente' DESC, br2.created_at DESC LIMIT 100`).bind(cid(c)).all();
  return json(c, { requests: results });
});
adminRouter.post("/block-requests/:id/resolve", async (c) => {
  const parsed = z.object({ approve: z.boolean() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "approve precisa ser true/false", 400);
  return resolveBlockReq(c,parsed.data.approve);
});

// ── CRUD barbeiros / serviços / produtos ────────────────────────────────────
const barberSchema = z.object({ name: z.string().min(2).max(80), specialty: z.string().max(80).default(""), bio: z.string().max(500).default(""), photo: z.string().max(500).default(""), ...barberScheduleFields, active: z.boolean().default(true), service_ids: z.array(z.number().int().positive()).default([]) });

adminRouter.get("/barbers", async (c) => {
  const db = P(c); const companyId = cid(c);
  const { results } = await db.prepare(`SELECT * FROM barbers WHERE company_id=?1 ORDER BY sort, name`).bind(companyId).all();
  // O editor da equipe precisa receber os serviços já vinculados ao barbeiro.
  // Sem service_ids, salvar uma simples edição de nome apaga os vínculos.
  const { results: links } = await db.prepare(`SELECT sb.barber_id, sb.service_id
    FROM service_barbers sb JOIN barbers b ON b.id=sb.barber_id
    JOIN services s ON s.id=sb.service_id AND s.company_id=b.company_id
    WHERE b.company_id=?1 ORDER BY sb.barber_id, sb.service_id`).bind(companyId)
    .all<{ barber_id: number; service_id: number }>();
  const byBarber = new Map<number, number[]>();
  for (const link of links)
    byBarber.set(link.barber_id, [...(byBarber.get(link.barber_id) ?? []), link.service_id]);
  return json(c, { barbers: results.map((b: Record<string, unknown>) => ({
    ...b, work_days: safeArr(String(b.work_days)),
    service_ids: byBarber.get(Number(b.id)) ?? [],
  })) });
});
adminRouter.post("/barbers", async (c) => {
  const parsed = barberSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const schedule = barberScheduleSchema.safeParse(parsed.data);
  if (!schedule.success) return err(c, "Expediente inválido", 422, schedule.error.flatten().fieldErrors);
  const db = P(c); const id = cid(c);
  if (!(await companyOwnsIds(db,"services",id,parsed.data.service_ids))) return err(c,"Serviço inválido para esta empresa",422);
  const limit = await planLimit(db, id, "max_barbers");
  if (parsed.data.active && limit >= 0) {
    const count = await db.prepare(`SELECT COUNT(*) n FROM barbers WHERE company_id=?1 AND active=1`).bind(id).first<{ n: number }>();
    if ((count?.n ?? 0) >= limit) return err(c, `Seu plano permite ${limit} barbeiros ativos. Faça upgrade no Tigu para mais vagas.`, 402);
  }
  const slug = await uniqueSlug(db, "barbers", slugify(parsed.data.name));
  const ins = await db.prepare(`INSERT INTO barbers (company_id, slug, name, specialty, bio, photo, work_days, work_start, work_end, break_start, break_end, active, created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13 WHERE ?12=0 OR ${barberCapacitySql("?1")}`).bind(id, slug, parsed.data.name.trim(), parsed.data.specialty, parsed.data.bio, parsed.data.photo, JSON.stringify(parsed.data.work_days), parsed.data.work_start, parsed.data.work_end, parsed.data.break_start, parsed.data.break_end, parsed.data.active ? 1 : 0, nowIso()).run();
  if (ins.meta.changes!==1) return err(c,"O limite de profissionais ativos do plano foi atingido. Atualize a equipe.",402);
  const barberId = ins.meta.last_row_id as number;
  await syncBarberServices(db, id, barberId, parsed.data.service_ids);
  return json(c, { ok: true, id: barberId, slug });
});

async function companyOwnsIds(db:D1Database,table:"services"|"barbers",companyId:number,ids:number[]) {
  const unique=[...new Set(ids)];
  if (!unique.length) return true;
  const rows=await db.prepare(`SELECT id FROM ${table} WHERE company_id=?1 AND id IN (${unique.map((_,i)=>`?${i+2}`).join(",")})`).bind(companyId,...unique).all();
  return rows.results.length===unique.length;
}
async function syncBarberServices(db:D1Database,companyId:number,barberId:number,serviceIds:number[]) {
  await db.batch([
    db.prepare("DELETE FROM service_barbers WHERE barber_id=?1 AND barber_id IN(SELECT id FROM barbers WHERE company_id=?2)").bind(barberId,companyId),
    ...[...new Set(serviceIds)].map(sid=>db.prepare(`INSERT OR IGNORE INTO service_barbers(service_id,barber_id)
      SELECT s.id,b.id FROM services s JOIN barbers b ON b.company_id=s.company_id
      WHERE s.id=?1 AND b.id=?2 AND s.company_id=?3`).bind(sid,barberId,companyId)),
  ]);
}
async function syncServiceBarbers(db:D1Database,companyId:number,serviceId:number,barberIds:number[]) {
  await db.batch([
    db.prepare("DELETE FROM service_barbers WHERE service_id=?1 AND service_id IN(SELECT id FROM services WHERE company_id=?2)").bind(serviceId,companyId),
    ...[...new Set(barberIds)].map(bid=>db.prepare(`INSERT OR IGNORE INTO service_barbers(service_id,barber_id)
      SELECT s.id,b.id FROM services s JOIN barbers b ON b.company_id=s.company_id
      WHERE s.id=?1 AND b.id=?2 AND s.company_id=?3`).bind(serviceId,bid,companyId)),
  ]);
}

adminRouter.put("/barbers/:id", async (c) => {
  const parsed = barberSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const db = P(c); const id = cid(c);
  const b = await db.prepare(`SELECT id,work_days,work_start,work_end,break_start,break_end FROM barbers WHERE id=?1 AND company_id=?2`).bind(await bookingIdParam(c), id).first<BarberRow>();
  if (!b) return err(c, "Barbeiro não encontrado", 404);
  const d = parsed.data as Record<string, unknown>;
  const scheduleChanged = Object.keys(barberScheduleFields).some((key) => key in d);
  if (scheduleChanged) {
    const schedule = barberScheduleSchema.safeParse({ ...b, work_days: safeArr(b.work_days), ...d });
    if (!schedule.success) return err(c, "Expediente inválido", 422, schedule.error.flatten().fieldErrors);
  }
  if ("service_ids" in d && !(await companyOwnsIds(db,"services",id,d.service_ids as number[]))) return err(c,"Serviço inválido para esta empresa",422);
  const sets: string[] = []; const binds: (string | number | null)[] = [];
  const map: Record<string, string> = { name: "name", specialty: "specialty", bio: "bio", photo: "photo", work_start: "work_start", work_end: "work_end", break_start: "break_start", break_end: "break_end" };
  for (const [k, col] of Object.entries(map)) if (k in d) { sets.push(`${col} = ?`); binds.push(String(d[k])); }
  if ("work_days" in d) { sets.push("work_days = ?"); binds.push(JSON.stringify(d.work_days)); }
  if ("active" in d) { sets.push("active = ?"); binds.push(d.active ? 1 : 0); }
  if (sets.length) {
    // Só grava sobre o expediente que foi validado; outra edição exige nova leitura.
    const scheduleGuard = scheduleChanged ? "AND work_days=? AND work_start=? AND work_end=? AND break_start=? AND break_end=?" : "";
    const expectedSchedule = scheduleChanged ? [b.work_days,b.work_start,b.work_end,b.break_start,b.break_end] : [];
    const updated=await db.prepare(`UPDATE barbers SET ${sets.join(", ")} WHERE id=? AND company_id=?
      AND (?=0 OR active=1 OR ${barberCapacitySql("barbers.company_id")}) ${scheduleGuard}`)
      .bind(...binds,b.id,id,d.active===true?1:0,...expectedSchedule).run();
    if (updated.meta.changes!==1) {
      if (scheduleChanged) return err(c,"A equipe foi alterada em outra operação ou atingiu o limite do plano. Atualize a página antes de salvar os horários.",409);
      return err(c,"O limite de profissionais ativos do plano foi atingido.",402);
    }
  }
  if ("service_ids" in d) await syncBarberServices(db, id, b.id, (d.service_ids as number[]) ?? []);
  return json(c, { ok: true });
});
adminRouter.delete("/barbers/:id", async (c) => {
  const db = P(c); const id = cid(c);
  const bid = await bookingIdParam(c);
  const exists = await db.prepare("SELECT id FROM barbers WHERE id=?1 AND company_id=?2").bind(bid,id).first();
  if (!exists) return err(c, "Barbeiro não encontrado", 404);
  const future = await db.prepare(`SELECT COUNT(*) n FROM bookings WHERE company_id=?1 AND barber_id=?2 AND status IN ('pendente','confirmado') AND starts_at > ?3`).bind(id, bid, new Date().toISOString()).first<{ n: number }>();
  if ((future?.n ?? 0) > 0) return err(c, "Há agendamentos futuros com este barbeiro — remarque-os antes de remover.", 409);
  await db.prepare(`UPDATE barbers SET active = 0 WHERE id = ?1 AND company_id = ?2`).bind(bid, id).run();
  return json(c, { ok: true, message: "Barbeiro desativado (histórico preservado)." });
});

async function planLimit(db: D1Database, companyId: number, col: "max_barbers" | "max_messages_month"): Promise<number> {
  const r = await db.prepare(`SELECT p.${col} AS v FROM plans p JOIN subscriptions s ON s.plan_code=p.code WHERE s.company_id=?1`).bind(companyId).first<{ v: number }>();
  return r?.v ?? -1;
}
function safeArr(v: string): number[] { try { const a = JSON.parse(v); return Array.isArray(a) ? a : []; } catch { return []; } }

// ── serviços ─────────────────────────────────────────────────────────────────
const serviceSchema = z.object({ name: z.string().min(2).max(80), description: z.string().max(300).default(""), price_cents: z.number().int().min(0).max(10_000_000), duration_min: z.number().int().min(5).max(480), category: z.string().max(40).default("cabelo"), photo: z.string().max(500).default(""), active: z.boolean().default(true), show_in_catalog: z.boolean().default(true), barber_ids: z.array(z.number().int().positive()).default([]) });
adminRouter.get("/services", async (c) => {
  const { results } = await P(c).prepare(`SELECT * FROM services WHERE company_id=?1 ORDER BY sort, name`).bind(cid(c)).all();
  const links = await P(c).prepare(`SELECT sb.service_id, sb.barber_id FROM service_barbers sb JOIN services s ON s.id=sb.service_id WHERE s.company_id=?1`).bind(cid(c)).all();
  const byS = new Map<number, number[]>();
  for (const l of links.results as { service_id: number; barber_id: number }[]) byS.set(l.service_id, [...(byS.get(l.service_id) || []), l.barber_id]);
  return json(c, { services: results.map((x: Record<string, unknown>) => ({ ...x, barber_ids: byS.get(Number(x.id)) ?? [] })) });
});
adminRouter.post("/services", async (c) => {
  const parsed = serviceSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const db = P(c); const id = cid(c);
  if (!(await companyOwnsIds(db,"barbers",id,parsed.data.barber_ids))) return err(c,"Barbeiro inválido para esta empresa",422);
  const slug = await uniqueSlug(db, "services", slugify(parsed.data.name));
  const ins = await db.prepare(`INSERT INTO services (company_id, slug, name, description, price_cents, duration_min, category, photo, active, show_in_catalog, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
    .bind(id, slug, parsed.data.name.trim(), parsed.data.description, parsed.data.price_cents, parsed.data.duration_min, parsed.data.category, parsed.data.photo, parsed.data.active ? 1 : 0, parsed.data.show_in_catalog ? 1 : 0, nowIso()).run();
  await syncServiceBarbers(db,id,Number(ins.meta.last_row_id),parsed.data.barber_ids);
  return json(c, { ok: true, id: ins.meta.last_row_id });
});
adminRouter.put("/services/:id", async (c) => {
  const parsed = serviceSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422);
  const db = P(c); const id = cid(c);
  const cur = await db.prepare(`SELECT id FROM services WHERE id=?1 AND company_id=?2`).bind(await bookingIdParam(c), id).first<{ id: number }>();
  if (!cur) return err(c, "Serviço não encontrado", 404);
  const d = parsed.data as Record<string, unknown>;
  if ("barber_ids" in d && !(await companyOwnsIds(db,"barbers",id,d.barber_ids as number[]))) return err(c,"Barbeiro inválido para esta empresa",422);
  const sets: string[] = []; const binds: (string | number)[] = [];
  for (const k of ["name", "description", "price_cents", "duration_min", "category", "photo"] as const) if (k in d) { sets.push(`${k} = ?`); binds.push(d[k] as string | number); }
  for (const k of ["active", "show_in_catalog"] as const) if (k in d) { sets.push(`${k} = ?`); binds.push(d[k] ? 1 : 0); }
  if (sets.length) await db.prepare(`UPDATE services SET ${sets.join(", ")} WHERE id=? AND company_id=?`).bind(...binds, cur.id, id).run();
  if ("barber_ids" in d) await syncServiceBarbers(db,id,cur.id,d.barber_ids as number[]);
  return json(c, { ok: true });
});
adminRouter.delete("/services/:id", async (c) => {
  const db = P(c); const id = cid(c);
  const sid = await bookingIdParam(c);
  const exists = await db.prepare("SELECT id FROM services WHERE id=?1 AND company_id=?2").bind(sid,id).first();
  if (!exists) return err(c, "Serviço não encontrado", 404);
  const used = await db.prepare(`SELECT COUNT(*) n FROM bookings WHERE service_id=?1 AND company_id=?2 AND status IN ('pendente','confirmado')`).bind(sid, id).first<{ n: number }>();
  if ((used?.n ?? 0) > 0) return err(c, "Serviço tem agendamentos ativos — cancele/remarque antes.", 409);
  await db.prepare(`UPDATE services SET active=0 WHERE id=?1 AND company_id=?2`).bind(sid, id).run();
  return json(c, { ok: true });
});

// ── produtos + estoque ───────────────────────────────────────────────────────
const productSchema = z.object({ name: z.string().min(2).max(90), description: z.string().max(400).default(""), price_cents: z.number().int().min(0), stock: z.number().int().min(0).max(100000).default(0), category: z.string().max(40).default("cuidados"), photo: z.string().max(500).default(""), active: z.boolean().default(true), featured: z.boolean().default(false) });
adminRouter.get("/products", async (c) => {
  const { results } = await P(c).prepare(`SELECT * FROM products WHERE company_id=?1 ORDER BY name`).bind(cid(c)).all();
  return json(c, { products: results });
});
adminRouter.post("/products", async (c) => {
  const parsed = productSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const db = P(c); const id = cid(c);
  const slug = await uniqueSlug(db, "products", slugify(parsed.data.name));
  const ins = await db.prepare(`INSERT INTO products (company_id, slug, name, description, price_cents, stock, category, photo, active, featured, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`)
    .bind(id, slug, parsed.data.name.trim(), parsed.data.description, parsed.data.price_cents, parsed.data.stock, parsed.data.category, parsed.data.photo, parsed.data.active ? 1 : 0, parsed.data.featured ? 1 : 0, nowIso()).run();
  const pid = ins.meta.last_row_id as number;
  if (parsed.data.stock > 0) await db.prepare(`INSERT INTO stock_movements (company_id, product_id, delta, reason, ref, created_at) VALUES (?1,?2,?3,'entrada','Cadastro inicial',?4)`).bind(id, pid, parsed.data.stock, nowIso()).run();
  return json(c, { ok: true, id: pid });
});
adminRouter.put("/products/:id", async (c) => {
  const parsed = productSchema.partial().extend({
    adjust_stock_by: z.number().int().min(-100000).max(100000).optional(),
    stock_reason: z.string().trim().min(3).max(120).optional(),
  }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const db = P(c); const id = cid(c);
  const cur = await db.prepare(`SELECT id FROM products WHERE id=?1 AND company_id=?2`).bind(await bookingIdParam(c), id).first<{ id: number }>();
  if (!cur) return err(c, "Produto não encontrado", 404);
  const { adjust_stock_by: delta = 0, stock_reason: reason } = parsed.data;
  if (delta !== 0 && !reason) return err(c, "Informe o motivo da movimentação de estoque", 422);
  const d = parsed.data as Record<string, unknown>;
  const sets: string[] = []; const binds: (string | number)[] = [];
  for (const k of ["name", "description", "price_cents", "category", "photo"] as const) if (k in d) { sets.push(`${k} = ?`); binds.push(d[k] as string | number); }
  for (const k of ["active", "featured"] as const) if (k in d) { sets.push(`${k} = ?`); binds.push(d[k] ? 1 : 0); }
  if (delta !== 0) { sets.push("stock = stock + ?"); binds.push(delta); }
  if (!sets.length) return json(c, { ok: true });
  const guard = delta !== 0 ? " AND stock + ? BETWEEN 0 AND 100000" : "";
  const update = db.prepare(`UPDATE products SET ${sets.join(", ")} WHERE id=? AND company_id=?${guard}`)
    .bind(...binds, cur.id, id, ...(delta !== 0 ? [delta] : []));
  if (delta === 0) {
    await update.run();
  } else {
    try {
      // Atualização de preço/dados, estoque e histórico: uma só transação D1.
      // O INSERT usa changes() para impedir movimentação se o UPDATE falhar.
      const results = await db.batch([
        update,
        db.prepare(`INSERT INTO stock_movements (company_id, product_id, delta, reason, ref, created_at)
          SELECT ?1,?2,?3,?4,'painel',?5 WHERE changes()=1`)
          .bind(id, cur.id, delta, reason!, nowIso()),
      ]);
      if (results[0].meta.changes !== 1)
        return err(c, "Estoque insuficiente, acima do limite ou alterado por outra operação", 409);
    } catch {
      return err(c, "Não foi possível atualizar o produto e o estoque. Nenhuma movimentação foi aplicada.", 409);
    }
  }
  return json(c, { ok: true });
});
adminRouter.delete("/products/:id", async (c) => {
  const db = P(c); const id = cid(c);
  const productId = await bookingIdParam(c);
  const exists = await db.prepare("SELECT id FROM products WHERE id=?1 AND company_id=?2")
    .bind(productId,id).first();
  if (!exists) return err(c, "Produto não encontrado", 404);
  // Desativação preserva order_items, ledger e fotos históricas de pedidos.
  await db.prepare("UPDATE products SET active=0,featured=0 WHERE id=?1 AND company_id=?2")
    .bind(productId,id).run();
  return json(c, { ok: true, message: "Produto retirado da vitrine; histórico e estoque preservados." });
});
adminRouter.post("/products/:id/stock", async (c) => {
  const parsed = z.object({ delta: z.number().int().min(-100000).max(100000).refine(v=>v!==0), reason: z.string().min(3).max(120).default("Ajuste manual") }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "delta (inteiro) é obrigatório", 400);
  const db = P(c); const id = cid(c);
  const cur = await db.prepare(`SELECT id, stock FROM products WHERE id=?1 AND company_id=?2`).bind(await bookingIdParam(c), id).first<{ id: number; stock: number }>();
  if (!cur) return err(c, "Produto não encontrado", 404);
  try {
    const results = await db.batch([
      db.prepare(`UPDATE products SET stock = stock + ?1 WHERE id=?2 AND company_id=?3 AND stock + ?1 >= 0`).bind(parsed.data.delta, cur.id, id),
      db.prepare(`INSERT INTO stock_movements (company_id, product_id, delta, reason, ref, created_at) SELECT ?1,?2,?3,?4,'painel',?5 WHERE changes()=1`).bind(id, cur.id, parsed.data.delta, parsed.data.reason.trim(), nowIso()),
    ]);
    if (results[0].meta.changes!==1) return err(c,"Estoque insuficiente ou alterado por outra operação",409);
  } catch {
    return err(c, "Estoque não pode ficar negativo", 409);
  }
  return json(c, { ok: true });
});

// ── pedidos da loja ──────────────────────────────────────────────────────────
adminRouter.get("/orders", async (c) => {
  const db = P(c); const id = cid(c);
  const status = c.req.query("status");
  const { results } = await db.prepare(`SELECT o.*,op.status AS payment_status FROM orders o LEFT JOIN order_payments op ON op.order_id=o.id AND op.company_id=o.company_id WHERE o.company_id=?1 ${status ? "AND o.status = ?2" : ""} ORDER BY o.id DESC LIMIT 200`).bind(id, ...(status ? [status] : [])).all();
  const ids = (results as { id: number }[]).map((r) => r.id);
  let items: { order_id: number; product_name: string; qty: number; unit_price_cents: number }[] = [];
  if (ids.length) items = (await db.prepare(`SELECT * FROM order_items WHERE order_id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`).bind(...ids).all()).results as typeof items;
  return json(c, { orders: results.map((o: Record<string, unknown>) => ({ ...o, items: items.filter((i) => i.order_id === Number(o.id)) })) });
});
async function orderStatusHandler(c: import("hono").Context<{ Bindings: Env }>) {
  const parsed = z.object({ status: z.enum(["novo", "pago", "entregue", "cancelado"]) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "status inválido", 400);
  const result = await changeOrderStatus(P(c),cid(c),await bookingIdParam(c),parsed.data.status);
  if (!result.ok) return err(c,result.message,result.status);
  return json(c,result);
}
adminRouter.post("/orders/:id/status", orderStatusHandler);

// ── avaliações ───────────────────────────────────────────────────────────────
adminRouter.get("/reviews", async (c) => {
  const { results } = await P(c).prepare(`SELECT r.*, br.name AS barber_name FROM reviews r JOIN barbers br ON br.id=r.barber_id WHERE r.company_id=?1 ORDER BY r.id DESC LIMIT 100`).bind(cid(c)).all();
  return json(c, { reviews: results });
});
adminRouter.delete("/reviews/:id", async (c) => {
  const db = P(c); const id = cid(c);
  const r = await db.prepare(`SELECT id, barber_id FROM reviews WHERE id=?1 AND company_id=?2`).bind(await bookingIdParam(c), id).first<{ id: number; barber_id: number }>();
  if (!r) return err(c, "Avaliação não encontrada", 404);
  await db.batch([
    db.prepare(`DELETE FROM reviews WHERE id=?1`).bind(r.id),
    db.prepare(`UPDATE barbers SET rating = COALESCE((SELECT ROUND(AVG(rating),2) FROM reviews WHERE barber_id=?1), 5.0), reviews_count = (SELECT COUNT(*) FROM reviews WHERE barber_id=?1) WHERE id=?1`).bind(r.barber_id),
  ]);
  return json(c, { ok: true });
});

// ── equipe (RBAC por empresa) ────────────────────────────────────────────────
adminRouter.get("/team", async (c) => {
  const { results } = await P(c)
    .prepare(`SELECT m.id AS membership_id, m.role, m.barber_id, m.active, u.id AS user_id, u.name, u.email, u.last_login_at, br.name AS barber_name
               FROM company_memberships m JOIN users u ON u.id=m.user_id LEFT JOIN barbers br ON br.id=m.barber_id
               WHERE m.company_id=?1 ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'manager' THEN 1 ELSE 2 END, u.name`)
    .bind(cid(c))
    .all();
  return json(c, { team: results });
});

const staffSchema = z.object({ name: z.string().min(2).max(90), email: z.string().email(), role: z.enum(["manager", "barber"]), barber_id: z.number().int().positive().nullable().default(null), password: z.string().min(10).max(128) });
adminRouter.post("/team", async (c) => {
  const parsed = staffSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos (senha mín. 10)", 422, parsed.error.flatten().fieldErrors);
  const db = P(c); const id = cid(c);
  const email = parsed.data.email.trim().toLowerCase();
  if (parsed.data.role === "barber" && !parsed.data.barber_id) return err(c, "Vincule o profissional ao barbeiro", 400);
  if (parsed.data.barber_id) {
    const barber = await db.prepare("SELECT id FROM barbers WHERE id=?1 AND company_id=?2 AND active=1").bind(parsed.data.barber_id,id).first();
    if (!barber) return err(c, "Barbeiro inválido para esta empresa", 400);
  }
  const clash = await db.prepare(`SELECT m.id FROM company_memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=?1 AND u.email=?2`).bind(id, email).first();
  if (clash) return err(c, "Este e-mail já participa desta barbearia", 409);
  const result = await createTeamAccount(db, {
    companyId: id, name: parsed.data.name.trim(), email,
    passwordHash: await hashPassword(parsed.data.password), role: parsed.data.role,
    barberId: parsed.data.barber_id, welcomeTitle: `Você entrou na equipe ${ctxSettings(c).shop_name}`,
  });
  if (!result.ok) return err(c, result.message, 409);
  await audit(db, c.get("user"), "team.create", "membership", result.userId, { email, role: parsed.data.role }, { companyId: id });
  return json(c, { ok: true, user_id: result.userId, created: true }, 201);
});

adminRouter.put("/team/:membershipId", async (c) => {
  const parsed = z.object({ role: z.enum(["manager", "barber"]).optional(), barber_id: z.number().int().positive().nullable().optional(), active: z.boolean().optional(), reset_password: z.string().min(10).max(128).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 400);
  const db = P(c); const id = cid(c);
  const mid = parseInt(c.req.param("membershipId") || "0", 10);
  const m = await db.prepare(`SELECT m.*, u.platform_role, u.password_hash FROM company_memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?1 AND m.company_id=?2`).bind(mid, id).first<TeamMemberSnapshot & { platform_role: string }>();
  if (!m) return err(c, "Membro não encontrado", 404);
  if (m.role === "owner") return err(c, "O papel de dono não é editável pelo painel (use o suporte Tigu).", 403);
  const d = parsed.data;
  if (d.reset_password) {
    const otherCompany = await db.prepare("SELECT id FROM company_memberships WHERE user_id=?1 AND company_id<>?2 LIMIT 1").bind(m.user_id,id).first();
    if (m.platform_role === "superadmin" || otherCompany)
      return err(c, "A senha desta conta global só pode ser redefinida pelo próprio usuário ou pelo suporte Tigu.", 403);
  }
  const removing = d.active === false;
  const role = removing ? m.role as "manager" | "barber" : d.role ?? m.role as "manager" | "barber";
  const barberId = role === "barber" ? (removing || d.barber_id === undefined ? m.barber_id : d.barber_id) : null;
  const validateBarber = !removing && role === "barber" && (d.active === true || d.role !== undefined || d.barber_id !== undefined);
  if (validateBarber) {
    if (!barberId) return err(c, "Vincule um profissional ativo ao acesso", 422);
    const barber = await db.prepare("SELECT id FROM barbers WHERE id=?1 AND company_id=?2 AND active=1").bind(barberId,id).first();
    if (!barber) return err(c, "Barbeiro inválido ou inativo para esta empresa", 400);
  }
  const changed = await updateTeamAccess(db,id,m,{
    role,barberId,active:removing?0:d.active===true?1:m.active,
    validateBarber,validateUser:d.active===true,
    passwordHash:!removing&&d.reset_password?await hashPassword(d.reset_password):undefined,
  });
  if (!changed) return err(c, "O acesso ou as permissões mudaram durante a operação. Atualize a página e tente novamente.", 409);
  await audit(db, c.get("user"), removing ? "team.remove" : "team.update", "membership", m.id,
    { role: d.role, active: d.active, reset: !removing && Boolean(d.reset_password) }, { companyId: id });
  return json(c, { ok: true });
});

// ── clientes + LGPD ──────────────────────────────────────────────────────────
adminRouter.get("/customers", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const id = cid(c);
  const where = q ? "AND (cu.name LIKE ?2 OR cu.phone LIKE ?2)" : "";
  // Mesma definição da tela: visitas incluem reservas canceladas; faturamento
  // considera somente atendimentos concluídos e pedidos pagos/entregues.
  // Agregações são filtradas por empresa ANTES de associar o telefone.
  const { results } = await P(c).prepare(`WITH booking_stats AS (
      SELECT customer_phone, COUNT(*) AS visits,
        SUM(CASE WHEN status='concluido' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status='cancelado' THEN 1 ELSE 0 END) AS canceled,
        SUM(CASE WHEN status='concluido' THEN price_cents ELSE 0 END) AS service_spent_cents,
        MAX(CASE WHEN status='concluido' THEN starts_at END) AS last_visit
      FROM bookings WHERE company_id=?1 AND status!='bloqueio'
      GROUP BY customer_phone
    ), purchase_stats AS (
      SELECT customer_phone, SUM(total_cents) AS product_spent_cents
      FROM orders WHERE company_id=?1 AND status IN ('pago','entregue')
      GROUP BY customer_phone
    )
    SELECT cu.id, cu.name, cu.phone, cu.email, cu.whatsapp_optin, cu.anonymized_at, cu.created_at,
      COALESCE(b.visits,0) AS visits,
      COALESCE(b.visits,0) AS bookings_count,
      COALESCE(b.completed,0) AS completed,
      COALESCE(b.canceled,0) AS canceled,
      COALESCE(b.service_spent_cents,0)+COALESCE(p.product_spent_cents,0) AS spent_cents,
      b.last_visit
    FROM customers cu
    LEFT JOIN booking_stats b ON b.customer_phone=cu.phone
    LEFT JOIN purchase_stats p ON p.customer_phone=cu.phone
    WHERE cu.company_id=?1 ${where}
    ORDER BY visits DESC, cu.name LIMIT 200`)
    .bind(id, ...(q ? [`%${q}%`] : [])).all();
  return json(c, { customers: results });
});
adminRouter.post("/customers/:id/anonymize", async (c) => {
  const db = P(c); const id = cid(c);
  const customerId = await bookingIdParam(c);
  const cust = await db.prepare(`SELECT id, phone, anonymized_at FROM customers WHERE id=?1 AND company_id=?2`)
    .bind(customerId, id).first<{ id: number; phone: string; anonymized_at: string | null }>();
  if (!cust) return err(c, "Cliente não encontrado", 404);
  if (cust.anonymized_at) return err(c, "Este cliente já foi anonimizado", 409);

  // A operação não deve quebrar o atendimento em aberto nem permitir envio
  // já assumido por outro Worker; o titular precisa resolver essas pendências.
  const blocking = await db.prepare(`SELECT
    EXISTS(SELECT 1 FROM bookings WHERE company_id=?1 AND
      (customer_id=?2 OR customer_phone=?3) AND status IN ('pendente','confirmado')) AS active_bookings,
    EXISTS(SELECT 1 FROM orders WHERE company_id=?1 AND customer_phone=?3 AND status='novo') AS open_orders,
    EXISTS(SELECT 1 FROM message_jobs j JOIN bookings b ON b.id=j.booking_id
      WHERE j.company_id=?1 AND b.company_id=?1
        AND (b.customer_id=?2 OR b.customer_phone=?3)
        AND (j.status='sending' OR (j.status IN ('scheduled','blocked_funds') AND j.reserved_cents>0))) AS active_messages`)
    .bind(id, cust.id, cust.phone)
    .first<{ active_bookings: number; open_orders: number; active_messages: number }>();
  if (blocking?.active_bookings || blocking?.open_orders || blocking?.active_messages)
    return err(c, "Existem agendamentos, pedidos ou envios financeiros pendentes. Conclua ou cancele essas operações antes de anonimizar.", 409);

  // Identificador sintético único por empresa e cliente; não é telefone válido.
  // Permite manter a vinculação do histórico financeiro sem reter o contato.
  const anonPhone = `anon-${id}-${cust.id}`;
  const anonName = "Cliente anonimizado";
  const at = nowIso();
  // Proteções de concorrência na MESMA transação D1: se um agendamento,
  // pedido ou envio surgir após a pré-checagem, nenhuma linha é alterada.
  const changed = await db.batch([
    db.prepare(`UPDATE customers SET name=?1, phone=?2, email=NULL, notes='',
      whatsapp_optin=0, anonymized_at=?3, lgpd_consent_at=NULL
      WHERE id=?4 AND company_id=?5 AND phone=?6 AND anonymized_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM bookings b WHERE b.company_id=?5
          AND (b.customer_id=?4 OR b.customer_phone=?6) AND b.status IN ('pendente','confirmado'))
        AND NOT EXISTS(SELECT 1 FROM orders o WHERE o.company_id=?5 AND o.customer_phone=?6 AND o.status='novo')
        AND NOT EXISTS(SELECT 1 FROM message_jobs j JOIN bookings b ON b.id=j.booking_id
          WHERE j.company_id=?5 AND b.company_id=?5 AND (b.customer_id=?4 OR b.customer_phone=?6)
            AND (j.status='sending' OR (j.status IN ('scheduled','blocked_funds') AND j.reserved_cents>0)))`)
      .bind(anonName, anonPhone, at, cust.id, id, cust.phone),
    db.prepare(`UPDATE bookings SET customer_name=?1, customer_phone=?2, customer_email=NULL,
      whatsapp_optin=0, notes='', cancel_token=''
      WHERE company_id=?3 AND (customer_id=?4 OR customer_phone=?5)
        AND EXISTS(SELECT 1 FROM customers WHERE id=?4 AND company_id=?3 AND phone=?2 AND anonymized_at=?6)`)
      .bind(anonName, anonPhone, id, cust.id, cust.phone, at),
    db.prepare(`UPDATE orders SET customer_name=?1, customer_phone=?2 WHERE company_id=?3 AND customer_phone=?4
      AND EXISTS(SELECT 1 FROM customers WHERE id=?5 AND company_id=?3 AND phone=?2 AND anonymized_at=?6)`)
      .bind(anonName, anonPhone, id, cust.phone, cust.id, at),
    db.prepare(`UPDATE reviews SET customer_name=?1, comment='' WHERE company_id=?2
      AND booking_id IN (SELECT id FROM bookings WHERE company_id=?2 AND customer_phone=?3)
      AND EXISTS(SELECT 1 FROM customers WHERE id=?4 AND company_id=?2 AND phone=?3 AND anonymized_at=?5)`)
      .bind(anonName, id, anonPhone, cust.id, at),
    db.prepare(`UPDATE message_jobs SET to_phone='',payload_json='{}',
      status=CASE WHEN status IN ('scheduled','blocked_funds') THEN 'skipped' ELSE status END,
      skip_reason=CASE WHEN status IN ('scheduled','blocked_funds') THEN 'anonimização LGPD' ELSE skip_reason END,
      next_attempt_at=NULL
      WHERE company_id=?1 AND booking_id IN
        (SELECT id FROM bookings WHERE company_id=?1 AND customer_phone=?2)
      AND EXISTS(SELECT 1 FROM customers WHERE id=?3 AND company_id=?1 AND phone=?2 AND anonymized_at=?4)`)
      .bind(id, anonPhone, cust.id, at),
    db.prepare(`UPDATE notifications SET title='Registro anonimizado',body='' WHERE company_id=?1 AND
      (booking_id IN (SELECT id FROM bookings WHERE company_id=?1 AND customer_phone=?2)
       OR (kind='order' AND EXISTS(SELECT 1 FROM orders o WHERE o.company_id=?1
          AND o.customer_phone=?2 AND instr(notifications.body,o.code)>0)))
      AND EXISTS(SELECT 1 FROM customers WHERE id=?3 AND company_id=?1 AND phone=?2 AND anonymized_at=?4)`)
      .bind(id, anonPhone, cust.id, at),
    db.prepare(`INSERT INTO notifications(company_id,audience,title,body,kind)
      SELECT ?1,'admin','Anonimização de cliente concluída','Registros operacionais descaracterizados; histórico financeiro preservado.','system'
      WHERE EXISTS(SELECT 1 FROM customers WHERE id=?2 AND company_id=?1 AND phone=?3 AND anonymized_at=?4)`)
      .bind(id, cust.id, anonPhone, at),
  ]);
  if (changed[0].meta.changes !== 1)
    return err(c, "Os dados ou operações do cliente mudaram. Recarregue o cadastro antes de anonimizar.", 409);
  await audit(db, c.get("user"), "customer.anonymize", "customer", cust.id, {}, { companyId: id });
  return json(c, { ok: true, message: "Contato e dados operacionais anonimizados. Valores e histórico financeiro preservados." });
});

// ── configurações da barbearia ───────────────────────────────────────────────
adminRouter.get("/settings", async (c) => json(c, { settings: ctxSettings(c) }));
adminRouter.put("/settings", async (c) => {
  const parsed = companySettingsSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Configurações inválidas", 422, parsed.error.flatten().fieldErrors);
  const db = P(c); const id = cid(c);
  // slug do site NÃO muda por aqui; brand/horários sim
  await saveCompanySettings(db, id, parsed.data);
  await audit(db, c.get("user"), "settings.update", "company_settings", id, {}, { companyId: id });
  return json(c, { ok: true });
});

// As credenciais de recebimento pertencem EXCLUSIVAMENTE ao proprietário do tenant.
// Nunca misturar com /billing (mensalidade) ou /wallet (recarga da plataforma).
adminRouter.get("/payments/mercadopago", async c => {
 if(c.get("user").company?.role!=="owner")return err(c,"Somente o proprietário pode gerenciar a conta recebedora.",403);
 return json(c,{integration:await merchantStatus(c.env,cid(c))});
});
adminRouter.put("/payments/mercadopago",async c=>{
 if(c.get("user").company?.role!=="owner")return err(c,"Apenas o dono da barbearia pode alterar os recebimentos.",403);
 const parsed=z.object({access_token:z.string().min(25).max(500),
  webhook_secret:z.string().min(16).max(500)}).safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success)return err(c,"Informe suas credenciais Mercado Pago.",422);
 const result=await configureMerchant(c.env,cid(c),parsed.data.access_token,parsed.data.webhook_secret);
 if(!result.ok)return err(c,result.message,result.status);
 await audit(c.env.DB,c.get("user"),"merchant.payment.connect","company_payment_integrations",cid(c),
  {account_id:result.account_id},{companyId:cid(c)});
 return json(c,{ok:true,integration:await merchantStatus(c.env,cid(c))});
});
adminRouter.delete("/payments/mercadopago",async c=>{
 if(c.get("user").company?.role!=="owner")return err(c,"Apenas o dono da barbearia pode desconectar o recebimento.",403);
 const result=await disconnectMerchant(c.env,cid(c));
 if(!result.ok)return err(c,result.message,result.status);
 await audit(c.env.DB,c.get("user"),"merchant.payment.disconnect","company_payment_integrations",cid(c),
  {},{companyId:cid(c)});
 return json(c,{ok:true});
});

// ── sino de notificações ─────────────────────────────────────────────────────
adminRouter.get("/notifications", async (c) => {
  const db = P(c); const id = cid(c);
  const [list, unread] = await Promise.all([
    db.prepare(`SELECT * FROM notifications WHERE company_id=?1 AND audience='admin' ORDER BY id DESC LIMIT 50`).bind(id).all(),
    db.prepare(`SELECT COUNT(*) n FROM notifications WHERE company_id=?1 AND audience='admin' AND read_at IS NULL`).bind(id).first<{ n: number }>(),
  ]);
  return json(c, { notifications: list.results, unread: unread?.n ?? 0 });
});
adminRouter.post("/notifications/read", async (c) => {
  await P(c).prepare(`UPDATE notifications SET read_at=?1 WHERE company_id=?2 AND audience='admin' AND read_at IS NULL`).bind(nowIso(), cid(c)).run();
  return json(c, { ok: true });
});

// ── WhatsApp: conexão, templates, histórico, disparo ────────────────────────
adminRouter.get("/whatsapp", async (c) => {
  const db = P(c); const id = cid(c);
  const conn = await getConnection(db, id);
  const { results: templates } = await db.prepare(`SELECT code, language, category, status, body_text, variables_n, use_case, active, updated_at FROM whatsapp_templates WHERE company_id=?1 ORDER BY use_case, code`).bind(id).all();
  const { results: jobs } = await db.prepare(
    `SELECT j.id, j.kind, j.status, j.to_phone, j.template_code, j.scheduled_at, j.sent_at, j.delivered_at, j.captured_at, j.refunded_at, j.attempts, j.last_error, j.price_cents, j.cost_cents, j.provider, j.demo,
            CASE WHEN j.status='sending' AND j.provider_msg_id=''
              AND (j.last_error LIKE 'Envio sem confirmação%'
                OR j.last_error LIKE 'Pendente de conferência%'
                OR j.last_attempt_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes'))
              THEN 1 ELSE 0 END AS requires_review,
            b.code AS booking_code, b.customer_name
     FROM message_jobs j LEFT JOIN bookings b ON b.id = j.booking_id
     WHERE j.company_id=?1 ORDER BY j.id DESC LIMIT 30`
  ).bind(id).all<Record<string, unknown> & { to_phone: string }>();
  const pricing = await resolvePricing(db, id, "any");
  const stats = await db.prepare(`SELECT COUNT(*) total, SUM(status IN ('sent','delivered','read')) sent, SUM(captured_at IS NOT NULL) charged, COALESCE(SUM(CASE WHEN captured_at IS NOT NULL THEN price_cents END),0) revenue_cents, COALESCE(SUM(CASE WHEN captured_at IS NOT NULL THEN cost_cents END),0) cost_cents FROM message_jobs WHERE company_id=?1 AND created_at>=strftime('%Y-%m-%dT%H:%M:%SZ','now','-30 days')`).bind(id).first();
  const plan = await db.prepare(`SELECT p.name, p.whatsapp_enabled, p.max_messages_month FROM plans p JOIN subscriptions s ON s.plan_code=p.code WHERE s.company_id=?1`).bind(id).first();
  const embedded = { available: Boolean(c.env.WHATSAPP_APP_ID && c.env.WHATSAPP_APP_SECRET_FOR_OAUTH && c.env.WHATSAPP_EMBEDDED_CONFIG_ID), config_id: c.env.WHATSAPP_EMBEDDED_CONFIG_ID || "" };
  return json(c, {
    connection: conn
      ? { provider: conn.provider, status: conn.status, display_phone: conn.display_phone, business_name: conn.business_name, waba_id: conn.waba_id, phone_number_id: conn.phone_number_id, coexistence: conn.coexistence, last_error: conn.last_error, last_check_at: conn.last_check_at, connected_at: conn.connected_at, demo: conn.demo, token_present: conn.access_token_enc !== "" }
      : { status: "disconnected", coexistence: "unknown" },
    templates,
    jobs: jobs.map((j) => ({ ...j, to_phone: maskPhoneLite(String(j.to_phone)) })),
    pricing,
    stats,
    plan,
    embedded,
    settings: {
      whatsapp_reminders_enabled: ctxSettings(c).whatsapp_reminders_enabled,
      whatsapp_confirm_enabled: ctxSettings(c).whatsapp_confirm_enabled,
      reminder_lead_min: ctxSettings(c).reminder_lead_min,
      short_lead_reminder_policy: ctxSettings(c).short_lead_reminder_policy,
      capture_on: ctxSettings(c).capture_on,
      reminder_template_code: ctxSettings(c).reminder_template_code,
      confirm_template_code: ctxSettings(c).confirm_template_code,
    },
    mock_available: c.env.WHATSAPP_MOCK === "1",
  });
});
function maskPhoneLite(p: string): string { return p.length > 7 ? `${p.slice(0, 4)}••••${p.slice(-3)}` : "•••"; }

const connectSchema = z.object({
  provider: z.enum(["meta_cloud", "mock"]),
  phone_number_id: z.string().max(40).default(""),
  waba_id: z.string().max(40).default(""),
  access_token: z.string().max(2000).default(""),
  display_phone: z.string().max(30).default(""),
  business_name: z.string().max(80).default(""),
  coexistence: z.enum(["unknown", "enabled", "not_eligible"]).default("unknown"),
});
adminRouter.post("/whatsapp/connect", async (c) => {
  const parsed = connectSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const db = P(c); const id = cid(c);
  const companyDemo = (await db.prepare(`SELECT demo FROM companies WHERE id=?1`).bind(id).first<{ demo: number }>())?.demo === 1;
  const d = parsed.data;
  if (c.env.TIGU_STAGING === "1" && d.provider !== "mock") return err(c, "Somente o WhatsApp de demonstração está permitido na homologação.", 403);
  if (d.provider === "mock") {
    if (!mockAllowed({ env: { WHATSAPP_MOCK: c.env.WHATSAPP_MOCK } as Env, demo: companyDemo })) return err(c, "Provedor mock indisponível neste ambiente.", 403);
    await db.prepare(
      `INSERT INTO whatsapp_connections (company_id, provider, status, display_phone, demo, created_at, updated_at) VALUES (?1,'mock','connected','5500MOCK0000',0,?2,?2)
       ON CONFLICT(company_id) DO UPDATE SET provider='mock', status='connected', last_error='', updated_at=?2`
    ).bind(id, nowIso()).run();
    await audit(db, c.get("user"), "whatsapp.connect.mock", "whatsapp_connection", id, {}, { companyId: id });
    return json(c, { ok: true, connected: true, note: "Conexão SIMULADA para demonstração — nenhum WhatsApp real é usado." });
  }
  if (!d.phone_number_id || !d.access_token) return err(c, "Para conectar de verdade informe o Phone Number ID e o token de acesso (System User token).", 422);
  const { encryptSecret } = await import("../lib/crypto");
  const tokenEnc = await encryptSecret(c.env, d.access_token);
  await db.prepare(
    `INSERT INTO whatsapp_connections (company_id, provider, status, phone_number_id, waba_id, display_phone, business_name, access_token_enc, coexistence, demo, created_at, updated_at)
     VALUES (?1,'meta_cloud','pending_setup',?2,?3,?4,?5,?6,?7,0,?8,?8)
     ON CONFLICT(company_id) DO UPDATE SET provider='meta_cloud', status='pending_setup', phone_number_id=excluded.phone_number_id, waba_id=excluded.waba_id, display_phone=excluded.display_phone,
       business_name=excluded.business_name, access_token_enc=excluded.access_token_enc, coexistence=excluded.coexistence, last_error='', updated_at=?8`
  ).bind(id, d.phone_number_id, d.waba_id, d.display_phone, d.business_name, tokenEnc, d.coexistence, nowIso()).run();

  // valida credencial ANTES de marcar conectado
  const connRow = await getConnection(db, id);
  const { provider } = await resolveProvider({ env: c.env as never, db, demo: false, conn: connRow });
  const st = provider ? await provider.status({ env: c.env as never, db, conn: connRow!, demo: false }) : { ok: false, error: "provedor indisponível" };
  await db.batch([
    db.prepare(`UPDATE whatsapp_connections SET status=?1, last_error=?2, last_check_at=?3, connected_at=CASE WHEN ?1='connected' THEN ?3 ELSE connected_at END, display_phone=COALESCE(NULLIF(?4,''),display_phone), business_name=COALESCE(NULLIF(?5,''),business_name), updated_at=?3 WHERE company_id=?6`)
      .bind(st.ok ? "connected" : "error", st.ok ? "" : String(st.error ?? "").slice(0, 300), nowIso(), st.ok ? String(st.display_phone ?? "") : "", st.ok ? String(st.verified_name ?? "") : "", id),
    db.prepare(`INSERT INTO notifications (company_id, audience, title, body, kind) VALUES (?1,'admin',?2,?3,'connection')`).bind(id, st.ok ? "WhatsApp conectado" : "Falha ao conectar WhatsApp", st.ok ? `Número ${st.display_phone ?? connRow?.display_phone} ativo para lembretes automáticos.` : `Erro: ${String(st.error).slice(0, 200)}`),
  ]);
  await audit(db, c.get("user"), "whatsapp.connect", "whatsapp_connection", id, { ok: st.ok, phone_number_id: d.phone_number_id }, { companyId: id });
  if (!st.ok) return json(c, { ok: true, connected: false, error: st.error, message: "Credenciais salvas, mas a verificação com a Meta falhou. Confira token/Phone Number ID e o webhook." }, 201);
  return json(c, { ok: true, connected: true }, 201);
});

adminRouter.post("/whatsapp/embedded/state", async (c) => {
  if (c.env.TIGU_STAGING === "1") return err(c, "Conexão com WhatsApp real indisponível na homologação. Use apenas o provedor de demonstração.", 403);
  const available = Boolean(c.env.WHATSAPP_APP_ID && c.env.WHATSAPP_APP_SECRET_FOR_OAUTH && c.env.WHATSAPP_EMBEDDED_CONFIG_ID);
  if (!available) return err(c, "Embedded Signup ainda não está provisionado para esta instância da plataforma (WHATSAPP_APP_ID/APP_SECRET/CONFIG_ID). Conecte manualmente com os IDs do painel da Meta ou fale com o suporte Tigu — veja docs/WHATSAPP.md.", 501);
  return json(c, { ok: true, app_id: c.env.WHATSAPP_APP_ID, config_id: c.env.WHATSAPP_EMBEDDED_CONFIG_ID });
});

adminRouter.post("/whatsapp/embedded/exchange", async (c) => {
  if (c.env.TIGU_STAGING === "1") return err(c, "Conexão com WhatsApp real indisponível na homologação. Use apenas o provedor de demonstração.", 403);
  const parsed = z.object({ code: z.string().min(10), config_id: z.string().min(1) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "code/config_id obrigatórios", 400);
  const res = await exchangeEmbeddedSignupCode(c.env, parsed.data.code, parsed.data.config_id);
  if (!res.ok) return err(c, res.error ?? "Falha na troca de código", 502);
  const { encryptSecret } = await import("../lib/crypto");
  const db = P(c); const id = cid(c);
  await db.prepare(
    `INSERT INTO whatsapp_connections (company_id, provider, status, phone_number_id, waba_id, access_token_enc, demo, created_at, updated_at)
     VALUES (?1,'meta_cloud','pending_setup',?2,?3,?4,0,?5,?5)
     ON CONFLICT(company_id) DO UPDATE SET provider='meta_cloud', status='pending_setup', phone_number_id=?2, waba_id=?3, access_token_enc=?4, updated_at=?5`
  ).bind(id, res.phone_number_id ?? "", res.waba_id ?? "", await encryptSecret(c.env, res.access_token ?? ""), nowIso()).run();
  const connRow = await getConnection(db, id);
  const st = await metaProviderStatus(c, connRow!);
  await db.prepare(`UPDATE whatsapp_connections SET status=?1, last_error=?2, last_check_at=?3, connected_at=CASE WHEN ?1='connected' THEN ?3 ELSE NULL END WHERE company_id=?4`).bind(st.ok ? "connected" : "pending_setup", st.ok ? "" : String(st.error ?? ""), nowIso(), id).run();
  await audit(db, c.get("user"), "whatsapp.embedded.connect", "whatsapp_connection", id, { waba_id: res.waba_id }, { companyId: id });
  return json(c, { ok: true, connected: st.ok, detail: st });
});
async function metaProviderStatus(c: { env: Env }, connRow: import("../lib/messaging/provider").ProviderConnectionRow) {
  const { metaProvider } = await import("../lib/messaging/provider");
  return metaProvider.status({ env: c.env as never, db: c.env.DB, conn: connRow, demo: false });
}

adminRouter.post("/whatsapp/check", async (c) => {
  const db = P(c); const id = cid(c);
  const conn = await getConnection(db, id);
  if (!conn || conn.status === "disconnected") return err(c, "Sem conexão para verificar", 404);
  const { provider } = await resolveProvider({ env: c.env as never, db, demo: conn.demo === 1, conn });
  if (!provider) return err(c, "Provedor indisponível", 503);
  const st = await provider.status({ env: c.env as never, db, conn, demo: conn.demo === 1 });
  await db.prepare(`UPDATE whatsapp_connections SET status=?1, last_error=?2, last_check_at=?3, updated_at=?3 WHERE company_id=?4`).bind(st.ok ? "connected" : "error", st.ok ? "" : String(st.error ?? "").slice(0, 300), nowIso(), id).run();
  if (!st.ok && conn.status === "connected") {
    await db.prepare(`INSERT INTO notifications (company_id, audience, title, body, kind) VALUES (?1,'admin','Conexão WhatsApp com problema',?2,'connection')`).bind(id, `A verificação falhou: ${String(st.error).slice(0, 160)}. Envios ficam em espera até resolver.`).run();
  }
  return json(c, { ok: st.ok, detail: st });
});

adminRouter.post("/whatsapp/disconnect", async (c) => {
  const db = P(c); const id = cid(c);
  const conn = await getConnection(db, id);
  if (!conn) return err(c, "Nada conectado", 404);
  const { provider } = await resolveProvider({ env: c.env as never, db, demo: conn.demo === 1, conn });
  if (provider) await provider.disconnect({ env: c.env as never, db, conn, demo: conn.demo === 1 });
  await audit(db, c.get("user"), "whatsapp.disconnect", "whatsapp_connection", id, {}, { companyId: id });
  return json(c, { ok: true, message: "Acesso da plataforma removido. O número continua sendo seu e nada muda no seu WhatsApp." });
});

adminRouter.post("/whatsapp/templates/sync", async (c) => {
  const db = P(c); const id = cid(c);
  const conn = await getConnection(db, id);
  if (!conn) return err(c, "Conecte o WhatsApp primeiro", 404);
  const { provider } = await resolveProvider({ env: c.env as never, db, demo: conn.demo === 1, conn });
  if (!provider) return err(c, "Provedor indisponível", 503);
  const res = await provider.listTemplates({ env: c.env as never, db, conn, demo: conn.demo === 1 });
  if (!res.ok) return err(c, res.error ?? "Falha ao listar templates", 502);
  const stmts = (res.templates ?? []).map((t) =>
    db.prepare(
      `INSERT INTO whatsapp_templates (company_id, code, language, category, status, body_text, use_case, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,'generic',?7)
       ON CONFLICT(company_id, code, language) DO UPDATE SET status=excluded.status, category=excluded.category, body_text=CASE WHEN excluded.body_text <> '' THEN excluded.body_text ELSE whatsapp_templates.body_text END, updated_at=?7`
    ).bind(id, t.code, t.language, (t.category || "UTILITY").toLowerCase(), t.status === "APPROVED" ? "approved" : t.status === "PENDING" ? "pending" : t.status === "REJECTED" ? "rejected" : "disabled", String(t.body_preview ?? "").slice(0, 900), nowIso())
  );
  if (stmts.length) await db.batch(stmts);
  return json(c, { ok: true, synced: stmts.length, hint: "Aprovação e edição de texto acontecem no painel da Meta (Business Manager); aqui você espelha e seleciona quais usar." });
});

const templateUpsertSchema = z.object({ code: z.string().min(2).max(60).regex(/^[a-z0-9_]+$/), language: z.string().default("pt_BR"), body_text: z.string().min(5).max(900), use_case: z.enum(["reminder", "confirmation", "generic"]).default("generic"), variables_n: z.number().int().min(0).max(10).default(0), active: z.boolean().default(true) });
adminRouter.put("/whatsapp/templates", async (c) => {
  const parsed = templateUpsertSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const d = parsed.data;
  const vars = (d.body_text.match(/\{\{\d+\}\}/g) ?? []).length;
  await P(c).prepare(
    `INSERT INTO whatsapp_templates (company_id, code, language, body_text, variables_n, use_case, active, status, updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'unknown',?8)
     ON CONFLICT(company_id, code, language) DO UPDATE SET body_text=excluded.body_text, variables_n=excluded.variables_n, use_case=excluded.use_case, active=excluded.active, updated_at=?8`
  ).bind(cid(c), d.code, d.language, d.body_text, Math.max(vars, d.variables_n), d.use_case, d.active ? 1 : 0, nowIso()).run();
  await audit(P(c), c.get("user"), "whatsapp.template.upsert", "whatsapp_template", d.code, {}, { companyId: cid(c) });
  return json(c, { ok: true, message: "Espelho local salvo. Lembre: o texto enviado é o APROVADO na Meta — envie a mesma redação lá para aprovação." });
});

adminRouter.post("/whatsapp/test", async (c) => {
  const parsed = z.object({ to: z.string().min(10).max(20), template: z.string().min(2).max(60).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "informe o número de destino", 400);
  const tpl = parsed.data.template || ctxSettings(c).reminder_template_code;
  const res = await sendImmediate(c.env, cid(c), { to: parsed.data.to.replace(/\D/g, ""), templateCode: tpl, kind: "test", test: true });
  if (!res.ok) return err(c, res.error ?? "Falha no envio de teste", 422);
  return json(c, { ok: true, jobId: res.jobId, message: "Teste enfileirado. O custo segue a tarifa vigente (aparece no extrato)." });
});

adminRouter.post("/whatsapp/run-now", async (c) => {
  const out = await processDueJobs(c.env, { companyId: cid(c), limit: 25 });
  return json(c, out);
});

adminRouter.post("/whatsapp/jobs/:id/retry", async (c) => {
  const db = P(c); const id = cid(c);
  const jobId = await bookingIdParam(c);
  const r = await db.prepare(`UPDATE message_jobs SET status='scheduled', attempts=0, next_attempt_at=NULL, last_error='reprocessado manualmente', updated_at=?1 WHERE id=?2 AND company_id=?3 AND status='failed' AND refunded_at IS NULL AND captured_at IS NULL AND last_error NOT LIKE 'Encerrado sem envio após confirmação externa%' AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-7 days')`).bind(nowIso(), jobId, id).run();
  if (!r.meta?.changes) return err(c, "Só é possível reprocessar falhas dos últimos 7 dias", 409);
  return json(c, { ok: true, message: "Job devolvido à fila; a cobrança continua idempotente (nunca cobra 2× pelo mesmo envio)." });
});

// ── carteira / recargas ──────────────────────────────────────────────────────
adminRouter.get("/wallet", async (c) => {
  const db = P(c); const id = cid(c);
  const wallet = await getWallet(db, id);
  const { results: txs } = await db.prepare(`SELECT type, amount_cents, balance_after, reserved_after, ref_type, ref_id, note, created_at FROM wallet_transactions WHERE company_id=?1 ORDER BY id DESC LIMIT 60`).bind(id).all();
  const { results: topups } = await db.prepare(`SELECT code, amount_cents, status, provider, qr_code_text, qr_code_base64, expires_at, paid_at, credited_at, created_at FROM topup_orders WHERE company_id=?1 ORDER BY id DESC LIMIT 20`).bind(id).all();
  const [pricing, topupLimits] = await Promise.all([resolvePricing(db, id, "any"), getTopupLimits(db)]);
  const monthSpend = await db.prepare(`SELECT COALESCE(SUM(-amount_cents),0) cents FROM wallet_transactions WHERE company_id=?1 AND type='capture' AND created_at>=strftime('%Y-%m-%dT00:00:00Z', date('now','start of month'))`).bind(id).first<{ cents: number }>();
  return json(c, {
    wallet: wallet ? { balance_cents: wallet.balance_cents, reserved_cents: wallet.reserved_cents, available_cents: wallet.balance_cents - wallet.reserved_cents, low_balance_alert_cents: wallet.low_balance_alert_cents, lifetime_charged_cents: wallet.lifetime_charged_cents, lifetime_recharged_cents: wallet.lifetime_recharged_cents } : null,
    transactions: txs,
    topups,
    pricing,
    topup_limits: topupLimits,
    month_spend_cents: monthSpend?.cents ?? 0,
    payments_available: Boolean(pickPaymentProvider(c.env, false).provider),
  });
});

adminRouter.post("/wallet/topup", async (c) => {
  const parsed = z.object({ amount_cents: z.number().int().min(100).max(10_000_000) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "valor inválido", 400);
  const res = await createTopup(c.env, cid(c), parsed.data.amount_cents, c.get("user")?.email ?? "", c.get("user"));
  if (!res.ok) return err(c, res.message, res.status ?? 400);
  return json(c, { ok: true, topup: res.topup, mock: res.mock }, 201);
});

adminRouter.get("/wallet/topup/:code", async (c) => {
  const db = P(c); const id = cid(c);
  const code = (c.req.param("code") || "").toUpperCase();
  const t = await db.prepare(`SELECT * FROM topup_orders WHERE code=?1 AND company_id=?2`).bind(code, id).first<{ id: number; status: string; provider_payment_id: string | null; amount_cents: number; code: string; qr_code_text: string; qr_code_base64: string; expires_at: string | null; paid_at: string | null; credited_at: string | null }>();
  if (!t) return err(c, "Recarga não encontrada", 404);
  if (t.status === "pending" && t.provider_payment_id) {
    await confirmTopupFromProvider(c.env, t.provider_payment_id, "poll").catch(() => null); // re-consulta defensiva
  }
  const fresh = await db.prepare(`SELECT status, paid_at, credited_at FROM topup_orders WHERE id=?1`).bind(t.id).first<{ status: string; paid_at: string | null; credited_at: string | null }>();
  return json(c, { topup: { ...t, ...fresh } });
});

/** Simulação LOCAL (demo/teste): emula o webhook do gateway — nunca disponível em produção real. */
adminRouter.post("/wallet/topup/:code/simulate", async (c) => {
  const db = P(c); const id = cid(c);
  const companyDemo = (await db.prepare(`SELECT demo FROM companies WHERE id=?1`).bind(id).first<{ demo: number }>())?.demo === 1;
  if (!companyDemo && c.env.PAYMENTS_MOCK !== "1") return err(c, "Simulação indisponível neste ambiente.", 403);
  const t = await db.prepare(`SELECT * FROM topup_orders WHERE code=?1 AND company_id=?2`).bind((c.req.param("code") || "").toUpperCase(), id).first<{ id: number; status: string; provider: string; provider_payment_id: string | null; code: string }>();
  if (!t) return err(c, "Recarga não encontrada", 404);
  if (t.status !== "pending") return json(c, { ok: true, note: "já resolvida", status: t.status });
  const res = await confirmTopupFromProvider(c.env, t.provider_payment_id || t.code, "mock");
  return json(c, { ok: res.credited, credited: res.credited, status: res.status });
});

adminRouter.post("/wallet/topup/:code/cancel", async (c) => {
  const db = P(c); const id = cid(c);
  const code = (c.req.param("code") || "").toUpperCase();
  const topup = await db.prepare("SELECT status,provider FROM topup_orders WHERE code=?1 AND company_id=?2")
    .bind(code,id).first<{status:string;provider:string}>();
  if (!topup) return err(c,"Recarga não encontrada",404);
  // A rota não cancela o pagamento junto ao Mercado Pago. Marcar um Pix real
  // como cancelado aqui perderia a reconciliação de um pagamento posterior.
  if (topup.provider !== "mock")
    return err(c,"Pix real não pode ser cancelado por este painel. Aguarde o vencimento; pagamentos aprovados serão conciliados.",409);
  const r = await db.prepare(`UPDATE topup_orders SET status='cancelled', updated_at=?1
    WHERE code=?2 AND company_id=?3 AND status='pending' AND provider='mock'`)
    .bind(nowIso(),code,id).run();
  if (!r.meta?.changes) return err(c,"Só dá para cancelar recargas simuladas pendentes",409);
  return json(c,{ok:true});
});

// ── uploads (R2) ─────────────────────────────────────────────────────────────
adminRouter.post("/upload", async (c) => {
  if (!c.env.MEDIA) return err(c, "R2 não configurado neste ambiente. Use URLs de fotos já hospedadas ou configure o binding (docs/DEPLOY.md).", 501);
  const body = await readUploadBody(c.req.raw);
  if (!body) return err(c, "Envio muito grande (imagem de até 5 MB)", 413);
  const form = await new Response(body, { headers: { "content-type": c.req.header("content-type") || "" } }).formData().catch(() => null);
  const raw = form?.get("file");
  const file = raw && typeof raw !== "string" ? (raw as File) : null;
  if (!file) return err(c, "Envie o campo 'file' em multipart/form-data", 400);
  if (file.size > MAX_IMAGE_BYTES) return err(c, "Imagem muito grande (máx. 5 MB)", 413);
  const ext = IMAGE_EXTENSIONS[file.type];
  if (!ext) return err(c, `Tipo não permitido (${file.type || "?"})`, 415);
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!hasImageSignature(bytes, file.type)) return err(c, "O conteúdo não corresponde a uma imagem do formato informado", 415);
  const key = `img/c${cid(c)}/${crypto.randomUUID()}.${ext}`;
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: file.type, cacheControl: "public, max-age=31536000, immutable" } });
  return json(c, { url: `/uploads/${key}` }, 201);
});

// ── compat/extra do painel (aliases PATCH + audit + detalhe cliente + blocks + credentials + demo) ──
adminRouter.get("/audit", async (c) => {
  const requested = Number(c.req.query("limit") || 25);
  const limit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(100, requested)) : 25;
  const { results } = await P(c).prepare("SELECT * FROM audit_log WHERE company_id=?1 ORDER BY id DESC LIMIT ?2")
    .bind(cid(c), limit).all();
  return json(c, { log: results });
});

adminRouter.get("/customers/:id", async (c) => {
  const db = P(c); const id = cid(c);
  const custId = await bookingIdParam(c);
  const cust = await db.prepare(`SELECT * FROM customers WHERE id=?1 AND company_id=?2`).bind(custId, id).first();
  if (!cust) return err(c, "Cliente não encontrado", 404);
  const [bookings, orders] = await Promise.all([
    db.prepare(`SELECT b.id, b.code, b.status, b.starts_at, b.price_cents, s.name AS service_name, br.name AS barber_name FROM bookings b LEFT JOIN services s ON s.id=b.service_id JOIN barbers br ON br.id=b.barber_id WHERE b.company_id=?1 AND b.customer_phone=(SELECT phone FROM customers WHERE id=?2) ORDER BY b.starts_at DESC LIMIT 30`).bind(id, custId).all(),
    db.prepare(`SELECT id, code, status, total_cents, created_at FROM orders WHERE company_id=?1 AND customer_phone=(SELECT phone FROM customers WHERE id=?2) ORDER BY id DESC LIMIT 20`).bind(id, custId).all(),
  ]);
  return json(c, { customer: cust, bookings: bookings.results, orders: orders.results });
});

adminRouter.post("/blocked-days", async (c) => {
  const parsed=dayBlockSchema.safeParse(await c.req.json().catch(()=>null));
  if (!parsed.success) return err(c,"Período inválido",422,parsed.error.flatten().fieldErrors);
  const result=await createAdminDayBlock(P(c),cid(c),parsed.data);
  if (!result.ok) return err(c,result.message,result.status);
  return json(c,result,201);
});

adminRouter.post("/blocks", async (c) => {
  const parsed=intervalBlockSchema.safeParse(await c.req.json().catch(()=>null));
  if (!parsed.success) return err(c,"Intervalo inválido",400,parsed.error.flatten().fieldErrors);
  const result=await createAdminIntervalBlock(P(c),cid(c),ctxSettings(c).timezone,parsed.data);
  if (!result.ok) return err(c,result.message,result.status);
  return json(c,result,201);
});

adminRouter.patch("/bookings/:id/status", async (c) => {
  const parsed = z.object({ status: z.enum(["confirmado", "concluido", "no_show", "cancelado"]) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "status inválido", 400);
  const ctx = { env: c.env, db: P(c), companyId: cid(c), settings: ctxSettings(c), origin: "admin" as const, user: c.get("user") };
  const bid = await bookingIdParam(c);
  if (parsed.data.status === "cancelado") {
    const r = await cancelBooking(ctx, bid, { actorRole: "admin", reason: "cancelado pelo painel" });
    if (!r.ok) return err(c, r.message, r.status);
    return json(c, { ok: true });
  }
  const { setBookingStatus } = await import("../lib/booking");
  const r = await setBookingStatus(ctx as never, bid, parsed.data.status);
  if (!r.ok) return err(c, r.message, r.status);
  return json(c, { ok: true });
});

adminRouter.patch("/orders/:id/status", orderStatusHandler);

adminRouter.post("/block-requests/:id/approve", async (c) => resolveBlockReq(c, true));
adminRouter.post("/block-requests/:id/reject", async (c) => resolveBlockReq(c, false));
async function resolveBlockReq(c: import("hono").Context<{ Bindings: Env }>, approve: boolean) {
  const result=await resolveBlockRequest(P(c),cid(c),await bookingIdParam(c),approve,ctxSettings(c).timezone);
  if (!result.ok) return err(c,result.message,result.status);
  return json(c,result);
}

/** Cria ou redefine acesso de uma conta exclusiva do mesmo profissional e empresa. */
adminRouter.post("/barbers/:id/credentials", async (c) => {
  const parsed = z.object({ email: z.string().email(), name: z.string().min(2).max(90).optional(), password: z.string().min(10).max(128).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "e-mail obrigatório (senha mín. 10)", 400, parsed.error.flatten().fieldErrors);
  const db = P(c); const id = cid(c);
  const barberId = await bookingIdParam(c);
  const barber = await db.prepare(`SELECT id, name FROM barbers WHERE id=?1 AND company_id=?2 AND active=1`).bind(barberId, id).first<{ id: number; name: string }>();
  if (!barber) return err(c, "Barbeiro não encontrado", 404);
  const email = parsed.data.email.trim().toLowerCase();
  const generated = parsed.data.password ? "" : `Tigu!${crypto.randomUUID().replace(/-/g,"" )}`;
  const pw = parsed.data.password || generated;
  const member=await db.prepare(`SELECT m.id,m.user_id,m.role,m.barber_id,m.active,u.password_hash,u.platform_role
    FROM company_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.company_id=?1 AND lower(u.email)=?2`)
    .bind(id,email).first<TeamMemberSnapshot & {platform_role:string}>();
  if (member) {
    // Nunca transformar conta de dono/gerente, outro barbeiro ou usuário global
    // em acesso deste profissional. updateTeamAccess protege a transação contra
    // troca de papéis, outras empresas e redefinições concorrentes.
    if(member.role!=="barber" || member.barber_id!==barberId || member.active!==1 || member.platform_role!=="user")
      return err(c,"Este e-mail pertence a outro acesso. Use a gestão de equipe.",409);
    const changed=await updateTeamAccess(db,id,member,{
      role:"barber",barberId,active:1,validateBarber:true,validateUser:true,
      passwordHash:await hashPassword(pw),
    });
    if(!changed) return err(c,"Este acesso foi alterado ou pertence a outra empresa. Atualize e tente novamente.",409);
    await audit(db,c.get("user"),"barber.credentials.reset","user",member.user_id,
      {email,barber_id:barberId},{companyId:id});
    return json(c,{ok:true,created:false,email,password:parsed.data.password?undefined:generated,
      message:"Senha redefinida. Sessões anteriores revogadas e nova troca obrigatória."});
  }
  const result=await createTeamAccount(db,{
    companyId:id,name:parsed.data.name || barber.name,email,
    passwordHash:await hashPassword(pw),role:"barber",barberId:barber.id,
  });
  if(!result.ok) return err(c,result.message,409);
  await audit(db,c.get("user"),"barber.credentials.create","user",result.userId,
    {email,barber_id:barber.id},{companyId:id});
  return json(c,{ok:true,created:true,email,password:parsed.data.password?undefined:generated,
    message:"Acesso criado. O profissional deverá trocar a senha no primeiro login."},201);
});

// ── demonstração (empresas com demo=1) ──────────────────────────────────────
adminRouter.get("/demo/status", async (c) => {
  const db = P(c); const id = cid(c);
  const co = await db.prepare(`SELECT demo FROM companies WHERE id=?1`).bind(id).first<{ demo: number }>();
  const counts = await db.prepare(`SELECT (SELECT COUNT(*) FROM bookings WHERE company_id=?1 AND demo=1) AS bookings, (SELECT COUNT(*) FROM customers WHERE company_id=?1 AND demo=1) AS customers, (SELECT COUNT(*) FROM reviews WHERE company_id=?1 AND demo=1) AS reviews, (SELECT COUNT(*) FROM message_jobs WHERE company_id=?1 AND demo=1) AS messages`).bind(id).first();
  return json(c, { demo_active: co?.demo === 1, counts });
});
adminRouter.post("/demo/reseed", async (c) => {
  const id = cid(c);
  const co = await P(c).prepare(`SELECT demo FROM companies WHERE id=?1`).bind(id).first<{ demo: number }>();
  if (co?.demo !== 1) return err(c, "Reseed de demonstração só se aplica a empresas de demonstração.", 403);
  const { seedDemoForCompany } = await import("../lib/demo-seed");
  const out = await seedDemoForCompany(P(c), id);
  return json(c, out);
});
adminRouter.delete("/demo", async (c) => {
  const id = cid(c);
  const co = await P(c).prepare(`SELECT demo FROM companies WHERE id=?1`).bind(id).first<{ demo: number }>();
  if (co?.demo !== 1) return err(c, "Nada a limpar — esta empresa não está marcada como demonstração.", 403);
  const db = P(c);
  await db.batch([
    db.prepare(`DELETE FROM message_attempts WHERE job_id IN (SELECT id FROM message_jobs WHERE company_id=?1 AND demo=1)`).bind(id),
    db.prepare(`DELETE FROM message_jobs WHERE company_id=?1 AND demo=1`).bind(id),
    db.prepare(`DELETE FROM booking_slots WHERE company_id=?1 AND demo=1`).bind(id),
    db.prepare(`DELETE FROM reviews WHERE company_id=?1 AND demo=1`).bind(id),
    db.prepare(`DELETE FROM bookings WHERE company_id=?1 AND demo=1`).bind(id),
    db.prepare(`DELETE FROM customers WHERE company_id=?1 AND demo=1`).bind(id),
    db.prepare(`DELETE FROM notifications WHERE company_id=?1 AND demo=1`).bind(id),
  ]);
  return json(c, { ok: true, message: "Dados fictícios desta barbearia removidos." });
});
