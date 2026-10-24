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
import { beginSellerOauth, sellerOauthEnabled } from "../lib/seller-mercadopago-oauth";
import { sellerPixReady } from "../lib/seller-payments";
import { calendarDaySchema } from "../lib/admin-blocks";
import { createBooking, setBookingStatus, cancelBooking, rescheduleBooking, finishBookingEarly, markBookingArrived } from "../lib/booking";
import { todayLocal, addDays, localToUtc, parseHHMM } from "../lib/time";
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


/** O profissional ajusta o tempo do próprio serviço, nunca o preço. */
barberRouter.get("/service-durations",async c=>{
 const m=me(c);
 if(!m.barber_id)return err(c,"Profissional não vinculado.",403);
 const {results}=await c.env.DB.prepare(
  "SELECT s.id AS service_id,s.name,s.duration_min AS default_duration_min,"+
  "sb.duration_override_min,COALESCE(sb.duration_override_min,s.duration_min) AS duration_min "+
  "FROM service_barbers sb JOIN barbers b ON b.id=sb.barber_id AND b.company_id=?1 AND b.active=1 "+
  "JOIN services s ON s.id=sb.service_id AND s.company_id=b.company_id AND s.active=1 "+
  "WHERE sb.barber_id=?2 ORDER BY s.name"
 ).bind(cid(c),m.barber_id).all();
 return json(c,{services:results});
});

barberRouter.put("/service-durations/:serviceId",async c=>{
 const m=me(c),serviceId=Number(c.req.param("serviceId"));
 if(!m.barber_id)return err(c,"Profissional não vinculado.",403);
 if(!Number.isSafeInteger(serviceId)||serviceId<1)return err(c,"Serviço inválido.",400);
 const parsed=z.object({
   duration_min:z.number().int().min(5).max(480).multipleOf(5).nullable()
 }).strict().safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success)return err(c,"Informe duração em múltiplos de 5 minutos, de 5 a 480, ou use padrão.",422);
 const updated=await c.env.DB.prepare(
  "UPDATE service_barbers SET duration_override_min=?1 "+
  "WHERE service_id=?2 AND barber_id=?3 "+
  "AND EXISTS(SELECT 1 FROM barbers b JOIN services s ON s.company_id=b.company_id "+
  "WHERE b.id=?3 AND b.company_id=?4 AND b.active=1 AND s.id=?2 AND s.active=1)"
 ).bind(parsed.data.duration_min,serviceId,m.barber_id,cid(c)).run();
 if(updated.meta.changes!==1)return err(c,"Serviço não atribuído a este profissional.",404);
 return json(c,{ok:true,duration_min:parsed.data.duration_min});
});

/** Encaixe manual: barbeiro vem da sessão; preço continua no D1. */
barberRouter.post("/fit-in",async c=>{
 const m=me(c);
 if(!m.barber_id)return err(c,"Profissional não vinculado.",403);
 const parsed=z.object({
   serviceId:z.number().int().positive(),
   day:calendarDaySchema,
   startTime:z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
   name:z.string().trim().min(2).max(90),
   phone:z.string().min(8).max(20),
   email:z.string().email().or(z.literal("")).optional(),
   notes:z.string().max(500).optional(),
   fitInDurationMin:z.number().int().min(5).max(180).multipleOf(5),
   idempotencyKey:z.string().min(8).max(64),
 }).strict().safeParse(await c.req.json().catch(()=>null));
 if(!parsed.success)return err(c,"Confira serviço, cliente, horário e duração do encaixe.",422,parsed.error.flatten().fieldErrors);
 const {day,startTime,...rest}=parsed.data;
 const startsAt=localToUtc(ctxSettings(c).timezone,day,parseHHMM(startTime))
   .toISOString().replace(/\.\d{3}Z$/,"Z");
 const input={...rest,startsAt,barberId:m.barber_id,consent:true,
   whatsappOptin:false,paymentChoice:"after_service" as const};
 const result=await createBooking({
  env:c.env,db:c.env.DB,companyId:cid(c),settings:ctxSettings(c),origin:"barbeiro",
  user:c.get("user") as never
 },input);
 if(!result.ok)return err(c,result.message,result.status);
 return json(c,{ok:true,id:result.bookingId,code:result.code,
  starts_at:result.startsAt,ends_at:result.endsAt,reused:result.reused??false},201);
});

const statusSchema = z.object({ status: z.enum(["confirmado", "concluido", "no_show"]) });
barberRouter.put("/bookings/:id/status", async (c) => {
  const parsed = statusSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "status inválido", 400);
  const s = ctxSettings(c);
  if (["concluido", "no_show"].includes(parsed.data.status) && !s.barber_can_conclude) return err(c, "O dono desativou conclusão pelo painel do barbeiro", 403);
  const m = me(c);
  const id = parseInt(c.req.param("id") || "0", 10);
  const own = await c.env.DB.prepare(`SELECT barber_id FROM bookings WHERE id=?1 AND company_id=?2`).bind(id, cid(c)).first<{ barber_id: number }>();
  if (!own) return err(c, "Agendamento não encontrado", 404);
  if (own.barber_id !== m.barber_id) return err(c, "Este atendimento não é seu", 403);
  const res = await setBookingStatus({ env: c.env, db: c.env.DB, companyId: cid(c), settings: s, origin: "barbeiro", user: c.get("user") as never }, id, parsed.data.status);
  if (!res.ok) return err(c, res.message, res.status);
  return json(c, { ok: true });
});

barberRouter.post("/bookings/:id/finish-early",async c=>{
 const settings=ctxSettings(c);
 if(!settings.barber_can_conclude)return err(c,"Conclusão pelo profissional desativada pelo dono.",403);
 const id=Number(c.req.param("id")),m=me(c);
 if(!Number.isSafeInteger(id)||id<1)return err(c,"Reserva inválida.",400);
 const booking=await c.env.DB.prepare("SELECT barber_id FROM bookings WHERE id=?1 AND company_id=?2")
   .bind(id,cid(c)).first<{barber_id:number}>();
 if(!booking)return err(c,"Reserva não encontrada.",404);
 if(booking.barber_id!==m.barber_id)return err(c,"Este atendimento não é seu.",403);
 const result=await finishBookingEarly({
   env:c.env,db:c.env.DB,companyId:cid(c),settings,origin:"barbeiro",user:c.get("user") as never
 },id);
 if(!result.ok)return err(c,result.message,result.status);
 return json(c,result);
});

barberRouter.post("/bookings/:id/check-in",async c=>{
  const m=me(c),id=Number(c.req.param("id"));
  if(!Number.isSafeInteger(id)||id<1)return err(c,"Agendamento inválido.",400);
  const row=await c.env.DB.prepare("SELECT barber_id FROM bookings WHERE id=?1 AND company_id=?2")
   .bind(id,cid(c)).first<{barber_id:number}>();
  if(!row)return err(c,"Agendamento não encontrado.",404);
  if(row.barber_id!==m.barber_id)return err(c,"Este atendimento não é seu.",403);
  const result=await markBookingArrived({
   env:c.env,db:c.env.DB,companyId:cid(c),settings:ctxSettings(c),origin:"barbeiro",
   user:c.get("user") as never
  },id);
  if(!result.ok)return err(c,result.message,result.status);
  return json(c,result);
});

barberRouter.post("/bookings/:id/cancel", async (c) => {
  const s = ctxSettings(c);
  if (!s.barber_can_cancel) return err(c, "Cancelamento pelo barbeiro está desativado — fale com o dono", 403);
  const m = me(c);
  const id = parseInt(c.req.param("id") || "0", 10);
  const own = await c.env.DB.prepare(`SELECT barber_id FROM bookings WHERE id=?1 AND company_id=?2`).bind(id, cid(c)).first<{ barber_id: number }>();
  if (!own) return err(c, "Agendamento não encontrado", 404);
  if (own.barber_id !== m.barber_id) return err(c, "Este atendimento não é seu", 403);
  const parsed=z.object({
   reason:z.enum(["Cliente desistiu","Avisou pelo WhatsApp","Não poderá comparecer","Outro motivo"]),
   details:z.string().trim().max(120).default("")
  }).strict().safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success)return err(c,"Selecione o motivo do cancelamento.",422);
  const reason=parsed.data.reason+(parsed.data.details?" — "+parsed.data.details:"");
  const res = await cancelBooking({ env: c.env, db: c.env.DB, companyId: cid(c), settings: s, origin: "barbeiro", user: c.get("user") as never }, id, { actorRole: "barbeiro", reason });
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
  // Ler a caixa não confirma leitura: somente POST /notifications/read altera read_at.
  const [list, unread] = await Promise.all([
    db.prepare(`SELECT * FROM notifications WHERE company_id=?1 AND audience='barber' AND user_id=?2 ORDER BY id DESC LIMIT 40`).bind(cid(c),m.id).all(),
    db.prepare(`SELECT COUNT(*) n FROM notifications WHERE company_id=?1 AND audience='barber' AND user_id=?2 AND read_at IS NULL`).bind(cid(c),m.id).first<{n:number}>(),
  ]);
  return json(c, { notifications: list.results, unread: unread?.n ?? 0 });
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
  if (["concluido", "no_show"].includes(parsed.data.status) && !s.barber_can_conclude) return err(c, "O dono desativou conclusão pelo painel do barbeiro", 403);
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
      `SELECT b.id, b.code, b.status, b.starts_at, b.ends_at, b.customer_name, b.customer_phone, b.notes, b.price_cents, b.origin, b.checked_in_at, b.cancel_reason, s.name AS service_name, s.duration_min AS default_duration_min
       FROM bookings b LEFT JOIN services s ON s.id=b.service_id
       WHERE b.company_id=?1 AND b.barber_id=?2 AND b.starts_at>=?3 AND b.starts_at<?4 AND b.status!='bloqueio' ORDER BY b.starts_at`
    )
    .bind(cid(c),m.barber_id,start,end)
    .all<Record<string, unknown> & { starts_at: string; ends_at: string; default_duration_min: number | null }>();
  const { utcToLocal } = await import("../lib/time");
  const byDay: Record<string, Record<string, unknown>[]> = {};
  for (const r of results) {
    const { day, minutes } = utcToLocal(tz, r.starts_at);
    // A tela recebe o horário local e a duração para exibir cada atendimento.
    const duration = Math.round((Date.parse(r.ends_at) - Date.parse(r.starts_at)) / 60000);
    byDay[day] = [...(byDay[day] || []), { ...r, label: fmt(minutes), duration_min: duration }];
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

/** Integração financeira individual: a credencial da plataforma não é
 * reutilizada para créditos, reservas ou produtos do barbeiro.
 * Até o fluxo OAuth + D1 individual + reconciliação passar em homologação,
 * o profissional NÃO pode ativar cobranças reais nem copiar secrets.
 */
barberRouter.get("/mercadopago", async (c) => {
  const m = me(c);
  if (!m.barber_id) return err(c, "Profissional não vinculado", 403);
  c.header("Cache-Control", "no-store");
  const configured = Boolean(
    c.env.MP_MARKETPLACE_CLIENT_ID?.trim() &&
    c.env.MP_MARKETPLACE_CLIENT_SECRET?.trim() &&
    c.env.MP_MARKETPLACE_REDIRECT_URI?.startsWith("https://")
  );
  // Staging não deve exigir migração de produção apenas para mostrar o painel.
  const account = c.env.TIGU_STAGING === "1" ? null
    : await c.env.DB.prepare(`SELECT mp_user_id, expires_at FROM seller_mp_accounts
 WHERE company_id=?1 AND barber_id=?2`).bind(cid(c),m.barber_id).first<{mp_user_id:string;expires_at:string}>();
  const expired = Boolean(account && Date.parse(account.expires_at) <= Date.now());
  return json(c, {
    connected: Boolean(account),
    token_expired: expired,
    enabled: await sellerPixReady(c.env,cid(c),m.barber_id),
    integration_mode: "oauth",
    app_configured: configured,
    can_connect: sellerOauthEnabled(c.env),
    stage: c.env.TIGU_STAGING === "1" ? "homologacao" : "oauth_disponivel",
    notice: account
      ? expired
        ? "Sua autorização Mercado Pago expirou. Reconecte a conta para atualizar a autorização."
        : await sellerPixReady(c.env,cid(c),m.barber_id)
          ? "Sua conta pode receber Pix de agendamentos diretamente pelo checkout."
          : "Conta conectada. Pix exige configuração do webhook e liberação de produção."
      : sellerOauthEnabled(c.env)
        ? "Conecte sua conta no Mercado Pago para preparar seus recebimentos."
        : "Conexão ainda indisponível neste ambiente. As mensalidades do TIGU permanecem separadas.",
  });
});

barberRouter.post("/mercadopago/connect", async c=>{
  const m=me(c);
  if(!m.barber_id)return err(c,"Profissional não vinculado",403);
  const result=await beginSellerOauth(c.env,{companyId:cid(c),barberId:m.barber_id,userId:m.id});
  if(!result.ok)return err(c,result.error,503);
  c.header("Set-Cookie",result.set_cookie);
  c.header("Cache-Control","no-store");
  return json(c,{authorization_url:result.authorization_url});
});

// Desconexão restrita ao profissional autenticado e seu vínculo multiempresa.
// Apaga os tokens locais e invalida autorizações OAuth ainda pendentes.
barberRouter.post("/mercadopago/disconnect", async (c) => {
  const m = me(c);
  if (!m.barber_id) return err(c, "Profissional não vinculado", 403);
  if (c.env.TIGU_STAGING === "1") return err(c, "Conexão financeira indisponível no staging.", 403);
  const companyId = cid(c);
  const unresolved=await c.env.DB.prepare("SELECT 1 FROM booking_payments WHERE company_id=?1 AND receiver_barber_id=?2 AND status IN ('creating','pending','refund_required') LIMIT 1")
    .bind(companyId,m.barber_id).first();
  if(unresolved)return err(c,"Existem Pix pendentes de conciliação ou estorno. Resolva antes de desconectar.",409);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM seller_mp_accounts WHERE company_id=?1 AND barber_id=?2")
      .bind(companyId, m.barber_id),
    c.env.DB.prepare("DELETE FROM seller_mp_oauth_pending WHERE company_id=?1 AND barber_id=?2")
      .bind(companyId, m.barber_id),
  ]);
  c.header("Cache-Control", "no-store");
  return json(c, { ok: true, connected: false });
});

barberRouter.get("/me", async (c) => {
  // já definido acima — este sobrescreve apenas para incluir permissions explícitas
  const m = me(c);
  const s = ctxSettings(c);
  const b = await c.env.DB.prepare(`SELECT id, name, photo, specialty, rating, reviews_count, work_days, work_start, work_end FROM barbers WHERE id=?1 AND company_id=?2`).bind(m.barber_id, cid(c)).first();
  return json(c, { me: { ...m, shop: s.shop_name }, barber: b ?? null, permissions: { can_conclude: s.barber_can_conclude, can_cancel: s.barber_can_cancel, can_block: s.barber_can_block } });
});
