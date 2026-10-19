// ============================================================================
// Painel DO BARBEIRO — /api/c/:slug/painel/... (membership role='barber',
// barber_id vinculado; impossível acessar agenda de colega por SQL: tudo
// filtrado por b.barber_id = membership.barber_id).
// ============================================================================
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { err, json, nowIso } from "../lib/utils";
import { cid, ctxSettings, tenantMiddleware } from "../lib/tenant";
import { calendarDaySchema } from "../lib/admin-blocks";
import { setBookingStatus, cancelBooking, rescheduleBooking } from "../lib/booking";
import { todayLocal, addDays, localToUtc } from "../lib/time";
import { computeDaySlots, type BarberRow } from "../lib/availability";
import type { ServiceRow } from "../lib/availability";

export const barberRouter = new Hono<{ Bindings: Env }>();
barberRouter.use("*", tenantMiddleware({ auth: "barber" }));

function me(c: { get: (k: string) => unknown }): { barber_id: number; id: number; name: string } {
  const u = c.get("user") as { id: number; name: string; company?: { barber_id: number | null } };
  return { id: u.id, name: u.name, barber_id: u.company?.barber_id ?? 0 };
}



// (agenda com days-map definida adiante — resposta única {days, work_days, blocked, from, to, bookings})

barberRouter.get("/free-slots", async (c) => {
  const m = me(c);
  const day = c.req.query("day") || todayLocal(ctxSettings(c).timezone);
  const db = c.env.DB;
  const barber = await db.prepare(`SELECT id, name, work_days, work_start, work_end, break_start, break_end, active FROM barbers WHERE id=?1 AND company_id=?2`).bind(m.barber_id, cid(c)).first<BarberRow>();
  if (!barber) return err(c, "Barbeiro inválido", 404);
  const service = await db.prepare(`SELECT id, name, duration_min, price_cents FROM services WHERE company_id=?1 AND active=1 ORDER BY id LIMIT 1`).bind(cid(c)).first<ServiceRow>();
  if (!service) return err(c, "Sem serviços", 404);
  return json(c, await computeDaySlots(db, { barber, service, day, settings: ctxSettings(c), mode: "public" }));
});

const statusSchema = z.object({ status: z.enum(["confirmado", "concluido", "no_show"]) });
barberRouter.put("/bookings/:id/status", async (c) => {
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "status inválido", 400);
  const s = ctxSettings(c);
  if (parsed.data.status === "concluido" && !s.barber_can_conclude) return err(c, "O dono desativou conclusão pelo painel do barbeiro", 403);
  const m = me(c);
  const id = parseInt(c.req.param("id") || "0", 10);
  const own = await c.env.DB.prepare(`SELECT barber_id FROM bookings WHERE id=?1 AND company_id=?2`).bind(id, cid(c)).first<{ barber_id: number }>();
  if (!own) return err(c, "Agendamento não encontrado", 404);
  if (own.barber_id !== m.barber_id) return err(c, "Este atendimento não é seu", 403);
  const res = await setBookingStatus({ env: c.env, db: c.env.DB, companyId: cid(c), settings: s, origin: "barbeiro", user: c.get("user") as never }, id, parsed.data.status);
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true });
});

barberRouter.post("/bookings/:id/cancel", async (c) => {
  const s = ctxSettings(c);
  if (!s.barber_can_cancel) return err(c, "Cancelamento pelo barbeiro está desativado — fale com o dono", 403);
  const m = me(c);
  const id = parseInt(c.req.param("id") || "0", 10);
  const own = await c.env.DB.prepare(`SELECT barber_id FROM bookings WHERE id=?1 AND company_id=?2`).bind(id, cid(c)).first<{ barber_id: number }>();
  if (!own) return err(c, "Agendamento não encontrado", 404);
  if (own.barber_id !== m.barber_id) return err(c, "Este atendimento não é seu", 403);
  const body = (await c.req.json().catch(() => ({}))) as { reason?: string };
  const res = await cancelBooking({ env: c.env, db: c.env.DB, companyId: cid(c), settings: s, origin: "barbeiro", user: c.get("user") as never }, id, { actorRole: "admin", reason: body.reason || `cancelado por ${m.name}` });
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true });
});

barberRouter.post("/bookings/:id/reschedule", async (c) => {
  const parsed = z.object({ startsAt: z.string() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "startsAt obrigatório", 400);
  const s = ctxSettings(c);
  const m = me(c);
  const id = parseInt(c.req.param("id") || "0", 10);
  const own = await c.env.DB.prepare(`SELECT barber_id FROM bookings WHERE id=?1 AND company_id=?2`).bind(id, cid(c)).first<{ barber_id: number }>();
  if (!own) return err(c, "Agendamento não encontrado", 404);
  if (own.barber_id !== m.barber_id) return err(c, "Este atendimento não é seu", 403);
  const res = await rescheduleBooking({ env: c.env, db: c.env.DB, companyId: cid(c), settings: s, origin: "barbeiro", user: c.get("user") as never }, id, parsed.data.startsAt, "barbeiro");
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true, starts_at: res.startsAt });
});

// pedido de folga/bloqueio → admin aprova
async function blockRequestHandler(c: import("hono").Context<{ Bindings: Env }>) {
  const parsed=z.object({
    day:z.string().optional(),date:z.string().optional(),
    startMin:z.number().int().min(0).max(1439).optional(),
    endMin:z.number().int().min(1).max(1440).optional(),
    reason:z.string().trim().min(3).max(200),
  }).safeParse(await c.req.json().catch(()=>null));
  if (!parsed.success) return err(c,"Dados inválidos",400);
  if (!ctxSettings(c).barber_can_block) return err(c,"O dono desativou bloqueios pelo painel do barbeiro",403);
  const d=parsed.data,day=d.date||d.day||"",date=new Date(`${day}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==day || (d.date&&d.day&&d.date!==d.day))
    return err(c,"Data inválida",400);
  if ((d.startMin==null)!==(d.endMin==null)) return err(c,"Informe início e fim juntos",400);
  const start=d.startMin??0,end=d.endMin??1440;
  if (end<=start) return err(c,"Fim deve ser depois do início",400);
  const m=me(c),db=c.env.DB,id=cid(c);
  const barber=await db.prepare("SELECT id FROM barbers WHERE id=?1 AND company_id=?2 AND active=1").bind(m.barber_id,id).first();
  if (!barber) return err(c,"Profissional inválido",403);
  await db.batch([
    db.prepare("INSERT INTO block_requests(company_id,barber_id,date,start_min,end_min,reason,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7)").bind(id,m.barber_id,day,start,end,d.reason,nowIso()),
    db.prepare("INSERT INTO notifications(company_id,audience,title,body,kind) VALUES (?1,'admin',?2,?3,'block_request')").bind(id,`Bloqueio solicitado por ${m.name}`,`${day} ${fmt(start)}–${fmt(end)} — ${d.reason}`),
  ]);
  return json(c,{ok:true,pending_approval:true,message:"Pedido enviado — aguarda aprovação do dono."},201);
}
barberRouter.post("/block-request",blockRequestHandler);
function fmt(min: number): string { return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`; }

barberRouter.get("/reviews", async (c) => {
  const m = me(c);
  const { results } = await c.env.DB.prepare(`SELECT rating, comment, customer_name, created_at FROM reviews WHERE company_id=?1 AND barber_id=?2 ORDER BY id DESC LIMIT 30`).bind(cid(c), m.barber_id).all();
  return json(c, { reviews: results });
});

barberRouter.get("/notifications", async (c) => {
  const m = me(c);
  const db = c.env.DB;
  const { results } = await db.prepare(`SELECT * FROM notifications WHERE company_id=?1 AND audience='barber' AND user_id=?2 ORDER BY id DESC LIMIT 40`).bind(cid(c), m.id).all();
  await db.prepare(`UPDATE notifications SET read_at=?1 WHERE company_id=?2 AND audience='barber' AND user_id=?3 AND read_at IS NULL`).bind(nowIso(), cid(c), m.id).run();
  return json(c, { notifications: results, unread: 0 });
});

// ── compatibilidade com o formato usado pelo painel do profissional ────────
barberRouter.patch("/bookings/:id/status", async (c) => {
  const parsed = z.object({ status: z.enum(["confirmado", "concluido", "no_show", "cancelado"]) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "status inválido", 400);
  const m = me(c);
  const id = cid(c);
  const bookingId = parseInt(c.req.param("id") || "0", 10);
  const own = await c.env.DB.prepare(`SELECT barber_id FROM bookings WHERE id=?1 AND company_id=?2`).bind(bookingId, id).first<{ barber_id: number }>();
  if (!own) return err(c, "Agendamento não encontrado", 404);
  if (own.barber_id !== m.barber_id) return err(c, "Este atendimento não é seu", 403);
  const s = ctxSettings(c);
  const ctx = { env: c.env, db: c.env.DB, companyId: id, settings: s, origin: "barbeiro" as const, user: c.get("user") as never };
  if (parsed.data.status === "cancelado") {
    if (!s.barber_can_cancel) return err(c, "Cancelamento pelo barbeiro desativado", 403);
    const r = await cancelBooking(ctx, bookingId, { actorRole: "admin", reason: `cancelado por ${m.name}` });
    if (!r.ok) return err(c, r.message, r.status);
    return json(c, { ok: true });
  }
  if (parsed.data.status === "concluido" && !s.barber_can_conclude) return err(c, "O dono desativou conclusão pelo painel do barbeiro", 403);
  const r = await setBookingStatus(ctx, bookingId, parsed.data.status);
  if (!r.ok) return err(c, r.message, r.status);
  return json(c, { ok: true });
});

/** agenda em mapa por dia: { days: { "YYYY-MM-DD": [itens] }, work_days, blocked } */
barberRouter.get("/agenda", async (c) => {
  const m = me(c);
  const query=z.object({from:calendarDaySchema.optional(),days:z.coerce.number().int().min(1).max(31).default(7)})
    .safeParse({from:c.req.query("from"),days:c.req.query("days")});
  if (!query.success) return err(c,"Período inválido. Use uma data real e entre 1 e 31 dias inteiros.",400);
  const tz=ctxSettings(c).timezone;
  const from=query.data.from??todayLocal(tz),daysN=query.data.days;
  const to=addDays(from,daysN);
  if (!calendarDaySchema.safeParse(to).success) return err(c,"Período fora do intervalo de datas suportado",400);
  const start=localToUtc(tz,from,0).toISOString().replace(/\.\d{3}Z$/,"Z");
  const end=localToUtc(tz,to,0).toISOString().replace(/\.\d{3}Z$/,"Z");
  const { results } = await c.env.DB
    .prepare(
      `SELECT b.id, b.code, b.status, b.starts_at, b.ends_at, b.customer_name, b.customer_phone, b.notes, b.price_cents, b.origin, s.name AS service_name
       FROM bookings b LEFT JOIN services s ON s.id=b.service_id
       WHERE b.company_id=?1 AND b.barber_id=?2 AND b.starts_at>=?3 AND b.starts_at<?4 AND b.status!='bloqueio' ORDER BY b.starts_at`
    )
    .bind(cid(c),m.barber_id,start,end)
    .all<Record<string, unknown> & { starts_at: string }>();
  const { utcToLocal } = await import("../lib/time");
  const byDay: Record<string, Record<string, unknown>[]> = {};
  for (const r of results) {
    const { day } = utcToLocal(tz, r.starts_at);
    byDay[day] = [...(byDay[day] || []), r];
  }
  const bd = await c.env.DB.prepare(`SELECT date_from, date_to, reason, kind FROM blocked_days WHERE company_id=?1 AND (barber_id=?2 OR barber_id IS NULL) AND date_to>=?3 AND date_from<=?4`).bind(cid(c), m.barber_id, from, addDays(from, daysN - 1)).all();
  const barberRow = await c.env.DB.prepare(`SELECT work_days FROM barbers WHERE id=?1 AND company_id=?2`).bind(m.barber_id, cid(c)).first<{ work_days: string }>();
  let work_days: number[] = [];
  try { work_days = JSON.parse(barberRow?.work_days || "[]"); } catch { /* noop */ }
  return json(c, { from, to, days: byDay, work_days, blocked: bd.results, bookings: results });
});

barberRouter.post("/block-requests",blockRequestHandler);

barberRouter.get("/block-requests", async (c) => {
  const m = me(c);
  const { results } = await c.env.DB.prepare(`SELECT id, date, start_min, end_min, reason, status, created_at FROM block_requests WHERE company_id=?1 AND barber_id=?2 ORDER BY id DESC LIMIT 30`).bind(cid(c), m.barber_id).all();
  return json(c, { requests: results });
});

barberRouter.post("/notifications/read", async (c) => {
  const m = me(c);
  await c.env.DB.prepare(`UPDATE notifications SET read_at=?1 WHERE company_id=?2 AND audience='barber' AND user_id=?3 AND read_at IS NULL`).bind(nowIso(), cid(c), m.id).run();
  return json(c, { ok: true });
});

barberRouter.get("/me", async (c) => {
  // já definido acima — este sobrescreve apenas para incluir permissions explícitas
  const m = me(c);
  const s = ctxSettings(c);
  const b = await c.env.DB.prepare(`SELECT id, name, photo, specialty, rating, reviews_count, work_days, work_start, work_end FROM barbers WHERE id=?1 AND company_id=?2`).bind(m.barber_id, cid(c)).first();
  return json(c, { me: { ...m, shop: s.shop_name }, barber: b ?? null, permissions: { can_conclude: s.barber_can_conclude, can_cancel: s.barber_can_cancel, can_block: s.barber_can_block } });
});
