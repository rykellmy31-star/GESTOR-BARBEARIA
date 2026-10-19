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
import { scheduleBookingMessage, cancelPendingJobs, bumpBookingVersion, type ScheduleOutcome } from "./messaging/jobs";
import { formatDateTimePtBr } from "./time";
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

  const check = await assertSlotAllowed(db, { barber, service, startsAt, settings, origin: ctx.origin });
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
                                 customer_name, customer_phone, customer_email, notes, whatsapp_optin, cancel_token, allowed_cancel_until, idempotency_key, demo, created_at, updated_at)
           VALUES (?1,?2,(SELECT id FROM customers WHERE company_id=?1 AND phone=?3),?4,?5,?6,?7,?8,'pendente',?9,?10,?3,?11,?12,?13,?14,?15,?16,?17,?18,?18)`
        )
        .bind(
          companyId, code, phone, barber.id, service.id, startsAt, check.endsAt, service.price_cents, ctx.origin,
          input.name.trim(), input.email || null, input.notes ?? "", input.whatsappOptin ? 1 : 0, cancelToken, allowedCancelUntil,
          input.idempotencyKey, demo, nowIso()
        ),
      ...slotKeys.map((k) => db.prepare(`INSERT INTO booking_slots (company_id, booking_id, barber_id, slot) SELECT ?1, id, ?2, ?3 FROM bookings WHERE code = ?4`).bind(companyId, barber.id, k, code)),
      ...insertBookingNotifications(
        db,
        companyId,
        { code, customer_name: input.name.trim(), customer_phone: phone, barber_id: barber.id, barber_name: barber.name, service_name: service.name, starts_at: startsAt, price_cents: service.price_cents, status: "pendente" },
        settings.timezone,
        "Novo agendamento recebido"
      ),
    ]);
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    if (msg.includes("UNIQUE constraint failed: booking_slots")) return { ok: false, message: "Ops! Este horário acabou de ser reservado por outra pessoa. Escolha outro horário.", status: 409 };
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
    status: "pendente",
    schedule_version: 1,
  };
  const messaging = await scheduleBookingMessage({ db, companyId, booking: bookingSnap, settings, kind: "reminder" });
  const confirmMessaging = await scheduleBookingMessage({ db, companyId, booking: bookingSnap, settings, kind: "confirmation" });

  await audit(db, ctx.user ?? null, "create", "booking", bookingId, { code, origin: ctx.origin, barber: barber.name, service: service.name }, { companyId });
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
    .first<Record<string, unknown> & { id: number; status: string; code: string; starts_at: string; allowed_cancel_until: string | null; customer_name: string; customer_phone: string; price_cents: number; service_name: string; barber_name: string; bid: number; barber_id: number; schedule_version: number }>();
  if (!b) return { ok: false, message: "Agendamento não encontrado", status: 404 };
  if (["cancelado", "concluido", "no_show"].includes(b.status)) return { ok: false, message: `Este agendamento está "${b.status}" e não pode ser cancelado`, status: 409 };
  if (opts.actorRole === "cliente" && !settings.allow_online_cancel) return { ok: false, message: "Cancelamentos on-line estão desativados pela barbearia. Fale conosco pelo WhatsApp.", status: 403 };
  if (opts.actorRole === "cliente" && b.allowed_cancel_until && Date.parse(b.allowed_cancel_until) < Date.now())
    return { ok: false, message: "O prazo para cancelamento on-line expirou. Fale conosco pelo WhatsApp.", status: 409 };

  await db.batch([
    db.prepare(`UPDATE bookings SET status='cancelado', notes = CASE WHEN ?2 = '' THEN notes ELSE notes || ' — ' || ?2 END, updated_at=?3 WHERE id=?1 AND company_id=?4`).bind(b.id, opts.reason ?? "", nowIso(), companyId),
    db.prepare(`DELETE FROM booking_slots WHERE booking_id = ?1 AND company_id = ?2`).bind(b.id, companyId),
    ...insertBookingNotifications(db, companyId, { code: String(b.code), customer_name: b.customer_name, customer_phone: b.customer_phone, barber_id: b.barber_id, barber_name: b.barber_name, service_name: b.service_name ?? "", starts_at: b.starts_at, price_cents: b.price_cents, status: "cancelado" }, settings.timezone, `Agendamento ${b.code} cancelado (${opts.actorRole})`, "cancel"),
  ]);
  // cancela lembretes/confirmações pendentes + libera reservas
  await cancelPendingJobs(db, companyId, b.id, null, "agendamento cancelado");
  await bumpBookingVersion(db, b.id);
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
  const b = await db.prepare(`SELECT * FROM bookings WHERE id = ?1 AND company_id = ?2`).bind(bookingId, companyId).first<{ id: number; status: string; barber_id: number; service_id: number; starts_at: string; code: string }>();
  if (!b) return { ok: false, message: "Agendamento não encontrado", status: 404 };
  if (["cancelado", "concluido", "no_show"].includes(b.status)) return { ok: false, message: "Status atual não permite remarcação", status: 409 };
  if (actorRole === "cliente") {
    if (!settings.allow_online_reschedule) return { ok: false, message: "Remarcação on-line desativada pela barbearia.", status: 403 };
    if (Date.parse(b.starts_at) - Date.now() < settings.reschedule_cutoff_min * 60000) return { ok: false, message: `Faltam menos de ${settings.reschedule_cutoff_min} min — remarque pelo WhatsApp`, status: 409 };
  }
  const barber = await db.prepare(`SELECT id, name, work_days, work_start, work_end, break_start, break_end, active FROM barbers WHERE id = ?1 AND company_id = ?2`).bind(b.barber_id, companyId).first<BarberRow>();
  const service = await db.prepare(`SELECT id, name, duration_min, price_cents FROM services WHERE id = ?1`).bind(b.service_id).first<ServiceRow>();
  if (!barber || !service) return { ok: false, message: "Dados do agendamento inconsistentes", status: 500 };

  let startsAt = newStartsAt;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(startsAt)) startsAt = startsAt.slice(0, 16) + ":00Z";
  const check = await assertSlotAllowed(db, { barber, service, startsAt, settings, origin: actorRole === "cliente" ? "cliente" : "admin", excludeBookingId: b.id });
  if (!check.ok) return { ok: false, message: check.error, status: check.status };

  const allowedCancelUntil = new Date(Date.parse(startsAt) - settings.cancel_cutoff_min * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const slotKeys = slotKeysFor(startsAt, check.endsAt, 5);
  try {
    await db.batch([
      db.prepare(`UPDATE bookings SET starts_at=?2, ends_at=?3, allowed_cancel_until=?4, schedule_version=schedule_version+1, updated_at=?5 WHERE id=?1 AND company_id=?6`).bind(b.id, startsAt, check.endsAt, allowedCancelUntil, nowIso(), companyId),
      db.prepare(`DELETE FROM booking_slots WHERE booking_id = ?1 AND company_id = ?2`).bind(b.id, companyId),
      ...slotKeys.map((k) => db.prepare(`INSERT INTO booking_slots (company_id, booking_id, barber_id, slot) VALUES (?1,?2,?3,?4)`).bind(companyId, b.id, b.barber_id, k)),
      ...insertBookingNotifications(db, companyId, { code: b.code, customer_name: "", customer_phone: "", barber_id: b.barber_id, barber_name: barber.name, service_name: service.name, starts_at: startsAt, price_cents: service.price_cents, status: "pendente" }, settings.timezone, `Agendamento ${b.code} remarcado para ${formatDateTimePtBr(settings.timezone, startsAt)}`, "reschedule"),
    ]);
  } catch (e) {
    if (String(e).includes("UNIQUE constraint failed: booking_slots")) return { ok: false, message: "O novo horário acabou de ser tomado. Escolha outro.", status: 409 };
    throw e;
  }
  // re-programação: cancela jobs antigos (qualquer kind) e agenda novo lembrete
  await cancelPendingJobs(db, companyId, b.id, null, "remarcado");
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

export async function setBookingStatus(ctx: BookingMutationCtx, bookingId: number, status: "confirmado" | "concluido" | "no_show"): Promise<{ ok: true } | { ok: false; message: string; status: number }> {
  const { db, companyId, settings } = ctx;
  const b = await db
    .prepare(`SELECT b.*, s.name AS service_name, br.name AS barber_name FROM bookings b LEFT JOIN services s ON s.id=b.service_id JOIN barbers br ON br.id=b.barber_id WHERE b.id=?1 AND b.company_id=?2`)
    .bind(bookingId, companyId)
    .first<Record<string, unknown> & { id: number; code: string; status: string; starts_at: string; customer_name: string; customer_phone: string; price_cents: number; barber_id: number; service_name: string; barber_name: string }>();
  if (!b) return { ok: false, message: "Agendamento não encontrado", status: 404 };
  const allowed: Record<string, string[]> = { pendente: ["confirmado", "concluido", "no_show"], confirmado: ["concluido", "no_show", "pendente"] };
  if (!(allowed[b.status] ?? []).includes(status)) return { ok: false, message: `Transição ${b.status} → ${status} não permitida`, status: 409 };
  await db.batch([
    db.prepare(`UPDATE bookings SET status=?2, updated_at=?3 WHERE id=?1 AND company_id=?4`).bind(b.id, status, nowIso(), companyId),
    ...insertBookingNotifications(db, companyId, { code: b.code, customer_name: b.customer_name, customer_phone: b.customer_phone, barber_id: b.barber_id, barber_name: b.barber_name, service_name: b.service_name ?? "", starts_at: b.starts_at, price_cents: b.price_cents, status }, settings.timezone, status === "confirmado" ? `Agendamento ${b.code} confirmado` : status === "concluido" ? `Atendimento ${b.code} concluído` : `Cliente não compareceu (${b.code})`, "booking"),
  ]);
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
