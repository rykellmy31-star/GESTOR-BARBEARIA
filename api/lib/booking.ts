import { isBookingConflictError } from "./booking-conflicts";
// ============================================================================
// SERVIÇO DE AGENDAMENTO (fonte única p/ público, painel e barbeiro).
//  - validação server-side completa (assertSlotAllowed)
//  - trava atômica: booking_slots UNIQUE(barber_id, slot) em batch (1 txn)
//  - idempotência por chave (duplo clique/rede)
//  - notificações do sino na MESMA transação
//  - fila de WhatsApp (lembrete/confirmação) logo após, best-effort
// Toda função exige companyId já resolvido no servidor (nunca do client).
// ============================================================================
import { z } from "zod";
import type { Env } from "../types";
import { bookingCode, err, json, nowIso, normalizePhone } from "./utils";
import { assertSlotAllowed, slotKeysFor, type BarberRow, type ServiceRow } from "./availability";
import { insertBookingNotifications } from "./notify";
import { scheduleBookingMessage, cancelPendingJobs, type ScheduleOutcome } from "./messaging/jobs";
import { formatDateTimePtBr,utcToLocal } from "./time";
import type { CompanySettings } from "./settings";
import type { SessionUser } from "../types";
import { audit } from "./audit";

export const createBookingSchema = z.object({
  serviceId: z.number().int().positive(),
  barberId: z.number().int().positive(),
  startsAt: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/),
  name: z.string().min(2).max(90),
  phone: z.string().min(8).max(20),
  email: z.string().email().or(z.literal("")).optional(),
  notes: z.string().max(500).optional(),
  whatsappOptin: z.boolean().default(false),
  consent: z.boolean().refine((v) => v === true, { message: "É necessário aceitar o uso dos dados (LGPD)" }),
  idempotencyKey: z.string().min(8).max(64),
  paymentChoice: z.enum(["after_service","pix"]).optional(),
  fitInDurationMin: z.number().int().min(5).max(180).multipleOf(5).optional(),
});

export interface BookingMutationCtx {
  env: Env;
  db: D1Database;
  companyId: number;
  settings: CompanySettings;
  origin: "cliente" | "admin" | "barbeiro";
  user?: SessionUser | null;
  demo?: number;
}

export interface CreateResult {
  ok: true;
  bookingId: number;
  code: string;
  startsAt: string;
  endsAt: string;
  reused?: boolean;
  cancelToken: string;
  allowedCancelUntil: string;
  messaging: ScheduleOutcome | null;
  confirmMessaging: ScheduleOutcome | null;
}

export async function createBooking(ctx: BookingMutationCtx, input: z.infer<typeof createBookingSchema>): Promise<CreateResult | { ok: false; message: string; status: number; issues?: unknown }> {
  const { db, companyId, settings } = ctx;
  if(input.fitInDurationMin!=null && !["admin","barbeiro"].includes(ctx.origin))
    return {ok:false,message:"Encaixe manual disponível somente para a equipe.",status:403};
  const existing = await db.prepare(`SELECT * FROM bookings WHERE idempotency_key = ?1 AND company_id = ?2`).bind(input.idempotencyKey, companyId).first<Record<string, unknown> & { id: number; starts_at: string; cancel_token: string; allowed_cancel_until: string }>();
  if (existing) {
    return {
      ok: true,
      bookingId: existing.id,
      code: String(existing.code),
      startsAt: existing.starts_at,
      endsAt: String(existing.ends_at),
      reused: true,
      cancelToken: existing.cancel_token,
      allowedCancelUntil: existing.allowed_cancel_until ?? "",
      messaging: null,
      confirmMessaging: null,
    };
  }

  const barber = await db
    .prepare(`SELECT id, name, work_days, work_start, work_end, break_start, break_end, active FROM barbers WHERE id = ?1 AND company_id = ?2`)
    .bind(input.barberId, companyId)
    .first<BarberRow>();
  const service = await db.prepare(`SELECT id, name, duration_min, price_cents FROM services WHERE id = ?1 AND company_id = ?2 AND active = 1`).bind(input.serviceId, companyId).first<ServiceRow>();
  if (!barber) return { ok: false, message: "Profissional não encontrado", status: 404 };
  if (!service) return { ok: false, message: "Serviço não encontrado", status: 404 };
  const link = await db.prepare(`SELECT 1 AS ok FROM service_barbers WHERE service_id = ?1 AND barber_id = ?2`).bind(service.id, barber.id).first();
  if (!link) return { ok: false, message: "Este profissional não realiza o serviço selecionado", status: 409 };

  let startsAt = input.startsAt;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(startsAt)) startsAt = startsAt.slice(0, 16) + ":00Z";

  const check = await assertSlotAllowed(db, { barber, service, startsAt, settings, origin: ctx.origin, fitInDurationMin:input.fitInDurationMin });
  if (!check.ok) return { ok: false, message: check.error, status: check.status };

  const phone = normalizePhone(input.phone);
  const code = bookingCode(settings.code_prefix);
  const cancelToken = crypto.randomUUID();
  const allowedCancelUntil = new Date(Date.parse(startsAt) - settings.cancel_cutoff_min * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const slotKeys = slotKeysFor(startsAt, check.endsAt, 5);
  const demo = ctx.demo ?? 0;

  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO customers (company_id, name, phone, email, whatsapp_optin, lgpd_consent_at, demo, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)
           ON CONFLICT(company_id, phone) DO UPDATE SET
             name = COALESCE(NULLIF(excluded.name,''), customers.name),
             email = COALESCE(NULLIF(excluded.email,''), customers.email),
             whatsapp_optin = MAX(customers.whatsapp_optin, excluded.whatsapp_optin),
             lgpd_consent_at = COALESCE(customers.lgpd_consent_at, excluded.lgpd_consent_at)`
        )
        .bind(companyId, input.name.trim(), phone, input.email || null, input.whatsappOptin ? 1 : 0, nowIso(), demo, nowIso()),
      db
        .prepare(
          `INSERT INTO bookings (company_id, code, customer_id, barber_id, service_id, starts_at, ends_at, price_cents, status, origin,
                                 customer_name, customer_phone, customer_email, notes, whatsapp_optin, cancel_token, allowed_cancel_until, idempotency_key, demo, created_at, updated_at,local_day,payment_choice,fit_in_duration_min)
           VALUES (?1,?2,(SELECT id FROM customers WHERE company_id=?1 AND phone=?3),?4,?5,?6,?7,?8,'confirmado',?9,?10,?3,?11,?12,?13,?14,?15,?16,?17,?18,?18,?19,?20,?21)`
        )
        .bind(
          companyId, code, phone, barber.id, service.id, startsAt, check.endsAt, service.price_cents, ctx.origin,
          input.name.trim(), input.email || null, input.notes ?? "", input.whatsappOptin ? 1 : 0, cancelToken, allowedCancelUntil,
          input.idempotencyKey, demo, nowIso(),utcToLocal(settings.timezone,startsAt).day,input.paymentChoice??"after_service",input.fitInDurationMin??null
        ),
      ...slotKeys.map((k) => db.prepare(`INSERT INTO booking_slots (company_id, booking_id, barber_id, slot) SELECT ?1, id, ?2, ?3 FROM bookings WHERE code = ?4`).bind(companyId, barber.id, k, code)),
      ...insertBookingNotifications(
        db,
        companyId,
        { code, customer_name: input.name.trim(), customer_phone: phone, barber_id: barber.id, barber_name: barber.name, service_name: service.name, starts_at: startsAt, price_cents: service.price_cents, status: "confirmado" },
        settings.timezone,
        "Novo agendamento recebido"
      ),
    ]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (isBookingConflictError(e)) return { ok: false, message: "Ops! Este horário acabou de ser reservado por outra pessoa. Escolha outro horário.", status: 409 };
    if (msg.includes("UNIQUE constraint failed: bookings.idempotency_key")) {
      const dup = await db.prepare(`SELECT * FROM bookings WHERE idempotency_key = ?1 AND company_id = ?2`).bind(input.idempotencyKey, companyId).first<Record<string, unknown> & { id: number; starts_at: string; cancel_token: string; allowed_cancel_until: string; code: string; ends_at: string }>();
      if (dup) {
        return { ok: true, bookingId: dup.id, code: dup.code, startsAt: dup.starts_at, endsAt: dup.ends_at, reused: true, cancelToken: dup.cancel_token, allowedCancelUntil: dup.allowed_cancel_until, messaging: null, confirmMessaging: null };
      }
      // A chave pode existir em outra empresa: nunca retornar sua reserva
      // nem seu token de cancelamento ao solicitante atual.
      return { ok: false, message: "Não foi possível reutilizar esta chave. Atualize a página e tente novamente.", status: 409 };
    }
    throw e;
  }

  const row = await db.prepare(`SELECT id FROM bookings WHERE code = ?1 AND company_id = ?2`).bind(code, companyId).first<{ id: number }>();
  const bookingId = row?.id ?? 0;

  // fila de mensagens (best-effort; nunca quebra o agendamento)
  const bookingSnap = {
    id: bookingId,
    company_id: companyId,
    code,
    customer_name: input.name.trim(),
    customer_phone: phone,
    whatsapp_optin: input.whatsappOptin ? 1 : 0,
    barber_name: barber.name,
    service_name: service.name,
    starts_at: startsAt,
    status: "confirmado",
    schedule_version: 1,
  };
  const messaging = await scheduleBookingMessage({ db, companyId, booking: bookingSnap, settings, kind: "reminder" });
  const confirmMessaging = await scheduleBookingMessage({ db, companyId, booking: bookingSnap, settings, kind: "confirmation" });

  await audit(db, ctx.user ?? null, "create", "booking", bookingId, { code, origin: ctx.origin, barber: barber.name, service: service.name, fit_in_duration_min:input.fitInDurationMin??null }, { companyId });
  return { ok: true, bookingId, code, startsAt, endsAt: check.endsAt, cancelToken, allowedCancelUntil, messaging, confirmMessaging };
}

export interface BookingCancelInput {
  bookingId: number;
  reason?: string;
}

export async function cancelBooking(ctx: BookingMutationCtx, bookingId: number, opts: { reason?: string; actorRole?: "cliente" | "admin" | "barbeiro" } = { actorRole: "admin" }): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const { db, companyId, settings } = ctx;
  const b = await db
    .prepare(
      `SELECT b.*, s.name AS service_name, br.name AS barber_name, br.id AS bid
       FROM bookings b LEFT JOIN services s ON s.id=b.service_id JOIN barbers br ON br.id=b.barber_id
       WHERE b.id = ?1 AND b.company_id = ?2`
    )
    .bind(bookingId, companyId)
    .first<Record<string, unknown> & { id: number; status: string; code: string; starts_at: string; allowed_cancel_until: string | null; customer_name: string; customer_phone: string; price_cents: number; service_name: string; barber_name: string; bid: number; barber_id: number; schedule_version: number; mutation_token:string }>();
  if (!b) return { ok: false, message: "Agendamento não encontrado", status: 404 };
  if (["cancelado", "concluido", "no_show"].includes(b.status)) return { ok: false, message: `Este agendamento está "${b.status}" e não pode ser cancelado`, status: 409 };
  if (opts.actorRole === "cliente" && !settings.allow_online_cancel) return { ok: false, message: "Cancelamentos on-line estão desativados pela barbearia. Fale conosco pelo WhatsApp.", status: 403 };
  if (opts.actorRole === "cliente" && b.allowed_cancel_until && Date.parse(b.allowed_cancel_until) < Date.now())
    return { ok: false, message: "O prazo para cancelamento on-line expirou. Fale conosco pelo WhatsApp.", status: 409 };

  const token=crypto.randomUUID();
  const results=await db.batch([
    db.prepare(`UPDATE bookings SET status='cancelado', notes = CASE WHEN ?2 = '' THEN notes ELSE notes || ' — ' || ?2 END,
      schedule_version=schedule_version+1,mutation_token=?5,updated_at=?3
      WHERE id=?1 AND company_id=?4 AND status=?6 AND schedule_version=?7 AND mutation_token=?8`)
      .bind(b.id,opts.reason??"",nowIso(),companyId,token,b.status,b.schedule_version,b.mutation_token),
    db.prepare(`DELETE FROM booking_slots WHERE booking_id=?1 AND company_id=?2
      AND EXISTS(SELECT 1 FROM bookings WHERE id=?1 AND company_id=?2 AND mutation_token=?3)`).bind(b.id,companyId,token),
    ...insertBookingNotifications(db, companyId, { code: String(b.code), customer_name: b.customer_name, customer_phone: b.customer_phone, barber_id: b.barber_id, barber_name: b.barber_name, service_name: b.service_name ?? "", starts_at: b.starts_at, price_cents: b.price_cents, status: "cancelado" }, settings.timezone, `Agendamento ${b.code} cancelado (${opts.actorRole})`, "cancel",token),
  ]);
  if(results[0].meta.changes!==1) return {ok:false,message:"Este agendamento foi alterado em outra operação. Atualize a agenda antes de cancelar.",status:409};
  // cancela lembretes/confirmações pendentes + libera reservas
  await cancelPendingJobs(db,companyId,b.id,null,"agendamento cancelado",undefined,b.schedule_version+1);
  await audit(db, ctx.user ?? null, "cancel", "booking", b.id, { code: b.code, via: opts.actorRole, reason: opts.reason ?? "" }, { companyId });
  return { ok: true };
}

export async function rescheduleBooking(
  ctx: BookingMutationCtx,
  bookingId: number,
  newStartsAt: string,
  actorRole: "cliente" | "admin" | "barbeiro"
): Promise<{ ok: true; startsAt: string; endsAt: string } | { ok: false; message: string; status: number }> {
  const { db, companyId, settings } = ctx;
  const b = await db.prepare(`SELECT * FROM bookings WHERE id = ?1 AND company_id = ?2`).bind(bookingId, companyId).first<{ id: number; status: string; barber_id: number; service_id: number; starts_at: string; code: string; schedule_version:number; mutation_token:string }>();
  if (!b) return { ok: false, message: "Agendamento não encontrado", status: 404 };
  if (["cancelado", "concluido", "no_show"].includes(b.status)) return { ok: false, message: "Status atual não permite remarcação", status: 409 };
  if (actorRole === "cliente") {
    if (!settings.allow_online_reschedule) return { ok: false, message: "Remarcação on-line desativada pela barbearia.", status: 403 };
    if (Date.parse(b.starts_at) - Date.now() < settings.reschedule_cutoff_min * 60000) return { ok: false, message: `Faltam menos de ${settings.reschedule_cutoff_min} min — remarque pelo WhatsApp`, status: 409 };
  }
  const barber = await db.prepare(`SELECT id, name, work_days, work_start, work_end, break_start, break_end, active FROM barbers WHERE id = ?1 AND company_id = ?2`).bind(b.barber_id, companyId).first<BarberRow>();
  const service = await db.prepare(`SELECT id, name, duration_min, price_cents FROM services WHERE id = ?1 AND company_id = ?2`).bind(b.service_id,companyId).first<ServiceRow>();
  if (!barber || !service) return { ok: false, message: "Dados do agendamento inconsistentes", status: 500 };

  let startsAt = newStartsAt;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(startsAt)) startsAt = startsAt.slice(0, 16) + ":00Z";
  const check = await assertSlotAllowed(db, { barber, service, startsAt, settings, origin: actorRole === "cliente" ? "cliente" : "admin", excludeBookingId: b.id });
  if (!check.ok) return { ok: false, message: check.error, status: check.status };

  const allowedCancelUntil = new Date(Date.parse(startsAt) - settings.cancel_cutoff_min * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const slotKeys = slotKeysFor(startsAt, check.endsAt, 5);
  const token=crypto.randomUUID();
  try {
    const results=await db.batch([
      db.prepare(`UPDATE bookings SET starts_at=?2, ends_at=?3, allowed_cancel_until=?4, schedule_version=schedule_version+1,mutation_token=?7,updated_at=?5,local_day=?11
        WHERE id=?1 AND company_id=?6 AND status=?8 AND schedule_version=?9 AND mutation_token=?10`)
        .bind(b.id,startsAt,check.endsAt,allowedCancelUntil,nowIso(),companyId,token,b.status,b.schedule_version,b.mutation_token,utcToLocal(settings.timezone,startsAt).day),
      db.prepare(`DELETE FROM booking_slots WHERE booking_id=?1 AND company_id=?2
        AND EXISTS(SELECT 1 FROM bookings WHERE id=?1 AND company_id=?2 AND mutation_token=?3)`).bind(b.id,companyId,token),
      db.prepare(`INSERT INTO booking_slots(company_id,booking_id,barber_id,slot)
        SELECT b.company_id,b.id,b.barber_id,j.value FROM bookings b,json_each(?4) j
        WHERE b.id=?1 AND b.company_id=?2 AND b.mutation_token=?3`).bind(b.id,companyId,token,JSON.stringify(slotKeys)),
      ...insertBookingNotifications(db, companyId, { code: b.code, customer_name: "", customer_phone: "", barber_id: b.barber_id, barber_name: barber.name, service_name: service.name, starts_at: startsAt, price_cents: service.price_cents, status: b.status }, settings.timezone, `Agendamento ${b.code} remarcado para ${formatDateTimePtBr(settings.timezone, startsAt)}`, "reschedule",token),
    ]);
    if(results[0].meta.changes!==1) return {ok:false,message:"Este agendamento foi alterado em outra operação. Atualize a agenda antes de remarcar.",status:409};
  } catch (e) {
    if (isBookingConflictError(e)) return { ok: false, message: "O novo horário acabou de ser tomado. Escolha outro.", status: 409 };
    throw e;
  }
  // re-programação: cancela jobs antigos (qualquer kind) e agenda novo lembrete
  await cancelPendingJobs(db,companyId,b.id,null,"remarcado",undefined,b.schedule_version+1);
  const full = await db
    .prepare(`SELECT b.id, b.code, b.customer_name, b.customer_phone, b.whatsapp_optin, b.status, b.starts_at, b.schedule_version, br.name AS barber_name, s.name AS service_name
               FROM bookings b JOIN barbers br ON br.id=b.barber_id LEFT JOIN services s ON s.id=b.service_id WHERE b.id=?1`)
    .bind(b.id)
    .first<Record<string, unknown> & { id: number; code: string; customer_name: string; customer_phone: string; whatsapp_optin: number; status: string; starts_at: string; schedule_version: number; barber_name: string; service_name: string }>();
  const messaging = full
    ? await scheduleBookingMessage({ db, companyId, booking: { ...full, company_id: companyId } as never, settings, kind: "reminder" })
    : null;
  await audit(db, ctx.user ?? null, "reschedule", "booking", b.id, { code: b.code, newStart: startsAt, via: actorRole }, { companyId });
  return { ok: true, startsAt, endsAt: check.endsAt };
}

/**
 * Libera apenas os minutos ainda disponíveis após um serviço encerrado.
 * Preserva fim originalmente previsto e instante real de conclusão.
 */
export async function finishBookingEarly(ctx:BookingMutationCtx,bookingId:number,at=new Date()):
 Promise<{ok:true;releasedFrom:string;originalEnd:string;minutesAvailable:number}|
 {ok:false;message:string;status:number}> {
 const {db,companyId,settings}=ctx;
 if(ctx.origin==="cliente")return {ok:false,message:"Somente o salão pode concluir o atendimento.",status:403};
 if(!Number.isSafeInteger(bookingId)||bookingId<1)return {ok:false,message:"Reserva inválida.",status:400};
 const b=await db.prepare(`SELECT b.*,s.name AS service_name,br.name AS barber_name
   FROM bookings b LEFT JOIN services s ON s.id=b.service_id
   JOIN barbers br ON br.id=b.barber_id WHERE b.id=?1 AND b.company_id=?2`)
   .bind(bookingId,companyId).first<{id:number;status:string;starts_at:string;ends_at:string;
    code:string;schedule_version:number;mutation_token:string;customer_name:string;
    customer_phone:string;price_cents:number;barber_id:number;
    service_name:string;barber_name:string}>();
 if(!b)return {ok:false,message:"Agendamento não encontrado.",status:404};
 if(!["pendente","confirmado"].includes(b.status))
  return {ok:false,message:"Somente atendimentos ativos podem liberar tempo.",status:409};
 const now=at.getTime(),start=Date.parse(b.starts_at),end=Date.parse(b.ends_at);
 if(!Number.isFinite(now)||now<start||now>=end)
  return {ok:false,message:"A conclusão antecipada só é permitida durante o atendimento.",status:409};
 const rounded=Math.ceil(now/300000)*300000;
 if(rounded+300000>end)
  return {ok:false,message:"Não restam pelo menos 5 minutos para encaixe.",status:409};
 const releasedFrom=new Date(rounded).toISOString().replace(/\.\d{3}Z$/,"Z");
 const finishedAt=at.toISOString().replace(/\.\d{3}Z$/,"Z");
 const token=crypto.randomUUID();
 try{
  const results=await db.batch([
   db.prepare(`UPDATE bookings SET status='concluido',
    scheduled_ends_at=COALESCE(scheduled_ends_at,ends_at),ends_at=?3,
    actual_finished_at=?4,schedule_version=schedule_version+1,
    mutation_token=?5,updated_at=?4
    WHERE id=?1 AND company_id=?2 AND status=?6 AND schedule_version=?7
      AND mutation_token=?8 AND starts_at<=?4 AND ends_at>?3`)
    .bind(b.id,companyId,releasedFrom,finishedAt,token,b.status,b.schedule_version,b.mutation_token),
   db.prepare(`DELETE FROM booking_slots WHERE booking_id=?1 AND company_id=?2
     AND EXISTS(SELECT 1 FROM bookings WHERE id=?1 AND company_id=?2
      AND mutation_token=?3 AND status='concluido')`)
    .bind(b.id,companyId,token),
   ...insertBookingNotifications(db,companyId,{
    code:b.code,customer_name:b.customer_name,customer_phone:b.customer_phone,
    barber_id:b.barber_id,barber_name:b.barber_name,service_name:b.service_name??"",
    starts_at:b.starts_at,price_cents:b.price_cents,status:"concluido"
   },settings.timezone,"Atendimento concluído antecipadamente, tempo liberado","booking",token),
  ]);
  if(results[0].meta.changes!==1)
   return {ok:false,message:"Reserva alterada por outra operação. Atualize a agenda.",status:409};
 }catch(e){
  if(isBookingConflictError(e))
   return {ok:false,message:"Conflito de agenda; atualize antes de concluir.",status:409};
  throw e;
 }
 await cancelPendingJobs(db,companyId,b.id,null,"concluído antecipadamente",undefined,b.schedule_version+1);
 await audit(db,ctx.user??null,"complete_early","booking",b.id,{
   originally_planned_end:b.ends_at,actual_finished_at:finishedAt,
   released_from:releasedFrom,minutes_available:(end-rounded)/60000
 },{companyId});
 return {ok:true,releasedFrom,originalEnd:b.ends_at,minutesAvailable:(end-rounded)/60000};
}

export async function setBookingStatus(ctx: BookingMutationCtx, bookingId: number, status: "confirmado" | "concluido" | "no_show"): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const { db, companyId, settings } = ctx;
  const b = await db
    .prepare(`SELECT b.*, s.name AS service_name, br.name AS barber_name FROM bookings b LEFT JOIN services s ON s.id=b.service_id JOIN barbers br ON br.id=b.barber_id WHERE b.id=?1 AND b.company_id=?2`)
    .bind(bookingId, companyId)
    .first<Record<string, unknown> & { id: number; code: string; status: string; starts_at: string; customer_name: string; customer_phone: string; price_cents: number; barber_id: number; service_name: string; barber_name: string; schedule_version:number; mutation_token:string }>();
  if (!b) return { ok: false, message: "Agendamento não encontrado", status: 404 };
  const allowed: Record<string, string[]> = { pendente: ["confirmado", "concluido", "no_show"], confirmado: ["concluido", "no_show", "pendente"] };
  if (!(allowed[b.status] ?? []).includes(status)) return { ok: false, message: `Transição ${b.status} → ${status} não permitida`, status: 409 };
  const token=crypto.randomUUID();
  try {
    const results=await db.batch([
      db.prepare(`UPDATE bookings SET status=?2,mutation_token=?5,updated_at=?3
        WHERE id=?1 AND company_id=?4 AND status=?6 AND schedule_version=?7 AND mutation_token=?8`)
        .bind(b.id,status,nowIso(),companyId,token,b.status,b.schedule_version,b.mutation_token),
      ...insertBookingNotifications(db, companyId, { code: b.code, customer_name: b.customer_name, customer_phone: b.customer_phone, barber_id: b.barber_id, barber_name: b.barber_name, service_name: b.service_name ?? "", starts_at: b.starts_at, price_cents: b.price_cents, status }, settings.timezone, status === "confirmado" ? `Agendamento ${b.code} confirmado` : status === "concluido" ? `Atendimento ${b.code} concluído` : `Cliente não compareceu (${b.code})`, "booking",token),
    ]);
    if(results[0].meta.changes!==1) return {ok:false,message:"Este agendamento foi alterado em outra operação. Atualize a agenda antes de mudar o status.",status:409};
  } catch (error) {
    if (isBookingConflictError(error)) return {ok:false,message:"Este atendimento conflita com outro horário. Atualize a agenda antes de confirmar.",status:409};
    throw error;
  }
  await audit(db, ctx.user ?? null, status, "booking", b.id, { code: b.code }, { companyId });
  return { ok: true };
}

/** resposta padronizada p/ rotas públicas */
export function bookingView(c: { json: (data: unknown, status?: number) => Response }, b: Record<string, unknown>, tz: string, status = 200) {
  return c.json(
    {
      ...b,
      starts_local: b.starts_at ? formatDateTimePtBr(tz, String(b.starts_at)) : "",
      price: Number(b.price_cents ?? 0) / 100,
    },
    status as Parameters<typeof c.json>[1]
  );
}
