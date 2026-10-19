// ============================================================================
// MOTOR DE MENSAGENS — fila persistente (message_jobs) + cron (~1/min).
// Regras de ouro (validadas por testes):
//  • preço/custo/política de captura congelados no job (snapshot no agendamento);
//  • 1 envio ⇒ no máximo 1 cobrança (idempotency_key por job + gate captured_at);
//  • reserva do saldo ao programar; falha permanente ⇒ liberação; entregue
//    conforme capture_on ⇒ captura; falha pós-cobrança ⇒ estorno (webhook);
//  • cancelou ⇒ jobs pendentes cancelados + reservas liberadas;
//  • remarcou ⇒ schedule_version++ e job antigo invalidado (nunca dispara);
//  • sem saldo ⇒ blocked_funds (re-tenta a cada ciclo; nada é cobrado);
//  • gates de negócio (opt-in, conexão, plano, habilitações) RE-VALIDADOS no
//    disparo — a empresa pode ter mudado configuração desde o agendamento;
//  • provedor nunca é chamado dentro de transação; reconciliação por sweep.
// ============================================================================
import type { Env } from "../../types";
import { nowIso } from "../utils";
import { loadPlatformSettings, type CompanySettings } from "../settings";
import { ensureWallet, reserveForJob, captureJobCharge, releaseJobReservation, refundJobCharge } from "../wallet";
import { resolveProvider, type ProviderContext, type ProviderConnectionRow } from "./provider";
import type { BookingRow } from "./types";

export type MessageKind = "reminder" | "confirmation" | "manual" | "test";

export interface SchedulingInput {
  db: D1Database;
  companyId: number;
  booking: BookingRow;
  settings: CompanySettings;
  kind: MessageKind;
  templateCode?: string; // para manual/test
  bodyPreview?: string;
  now?: Date;
}

export interface PricedRule {
  price_cents: number;
  cost_cents: number;
  category: "utility" | "marketing" | "authentication";
}

/** precificação vigente: regra da empresa > global; superadmin edita sem deploy */
export async function resolvePricing(db: D1Database, companyId: number, category: "any" | "utility" | "marketing" | "authentication"): Promise<PricedRule> {
  const row = await db
    .prepare(
      `SELECT price_cents, cost_cents, category FROM pricing_rules
       WHERE active = 1 AND ((company_id = ?1 AND (category = ?2 OR category = 'any'))
          OR (company_id IS NULL AND (?2 = 'any' OR category = ?2 OR category = 'any')))
       ORDER BY (company_id IS NULL) ASC, updated_at DESC LIMIT 1`
    )
    .bind(companyId, category)
    .first<{ price_cents: number; cost_cents: number; category: string }>();
  if (row) return { price_cents: row.price_cents, cost_cents: row.cost_cents, category: row.category === "any" ? "utility" : (row.category as PricedRule["category"]) };
  const p = await loadPlatformSettings(db);
  return { price_cents: Number(p.msg_price_cents), cost_cents: Number(p.msg_cost_cents), category: "utility" };
}

export async function getConnection(db: D1Database, companyId: number): Promise<ProviderConnectionRow | null> {
  return db.prepare(`SELECT * FROM whatsapp_connections WHERE company_id = ?1`).bind(companyId).first<ProviderConnectionRow>();
}

export interface ScheduleOutcome {
  ok: boolean;
  status: "scheduled" | "blocked_funds" | "skipped" | "no_connection";
  reason?: string;
  jobId?: number;
}

/**
 * Agenda (ou re-agenda) a mensagem de um agendamento. Idempotente por
 * (booking, kind, schedule_version). Nunca lança — agendamento de mensagem
 * jamais pode quebrar a criação do booking.
 */
export async function scheduleBookingMessage(inp: SchedulingInput): Promise<ScheduleOutcome> {
  const { db, companyId, booking, settings, kind } = inp;
  const now = inp.now ?? new Date();
  try {
    const startMs = Date.parse(booking.starts_at);
    const vRow = await db.prepare(`SELECT schedule_version FROM bookings WHERE id = ?1 AND company_id = ?2`).bind(booking.id, companyId).first<{ schedule_version: number }>();
    const version = vRow?.schedule_version ?? 1;

    // Remarcação invalida versões antigas, mas nunca cancela a mensagem
    // da própria versão quando o agendamento é processado novamente.
    const currentIdempotencyKey = `booking-${booking.id}-${kind}-v${version}`;
    await cancelPendingJobs(db, companyId, booking.id, kind, "reagendado ou remarcado", currentIdempotencyKey);

    if (booking.status !== "pendente" && booking.status !== "confirmado") return { ok: true, status: "skipped", reason: "agendamento não está ativo" };
    if (startMs <= now.getTime()) return { ok: true, status: "skipped", reason: "início já passou" };
    if (kind === "reminder" && !settings.whatsapp_reminders_enabled) return { ok: true, status: "skipped", reason: "lembretes desativados pela barbearia" };
    if (kind === "confirmation" && !settings.whatsapp_confirm_enabled) return { ok: true, status: "skipped", reason: "confirmações desativadas" };
    if (!booking.whatsapp_optin) return { ok: true, status: "skipped", reason: "cliente sem opt-in" };
    if (!/^\d{10,15}$/.test((booking.customer_phone || "").replace(/\D/g, ""))) return { ok: true, status: "skipped", reason: "sem número válido" };

    const conn = await getConnection(db, companyId);
    if (!conn || conn.status !== "connected") return { ok: true, status: "no_connection", reason: "WhatsApp desta barbearia não está conectado" };

    const tplCode = kind === "reminder" ? (inp.templateCode || settings.reminder_template_code) : kind === "confirmation" ? (inp.templateCode || settings.confirm_template_code) : inp.templateCode || "";
    const tpl = await db
      .prepare(`SELECT code, language, body_text FROM whatsapp_templates WHERE company_id = ?1 AND code = ?2 AND active = 1`)
      .bind(companyId, tplCode)
      .first<{ code: string; language: string; body_text: string }>();
    if (!tpl) return { ok: true, status: "skipped", reason: `template "${tplCode}" não cadastrado para esta barbearia` };

    // timing: lembrete exatamente N min antes; prazo limite = início + folga do cron
    let fireAtMs: number;
    if (kind === "reminder") {
      const leadMin = settings.reminder_lead_min;
      fireAtMs = startMs - leadMin * 60_000;
      if (fireAtMs <= now.getTime()) {
        if (settings.short_lead_reminder_policy === "send_immediate") fireAtMs = now.getTime() + 30_000;
        else return { ok: true, status: "skipped", reason: `faltam menos de ${leadMin} min e a política da barbearia é não enviar` };
      }
    } else {
      fireAtMs = now.getTime() + 20_000; // confirmação/teste: quase imediato
    }
    const fireDeadlineMs = startMs + 15 * 60_000;
    const idem = currentIdempotencyKey;
    const price = await resolvePricing(db, companyId, "utility");
    const platform = await loadPlatformSettings(db);
    const company = await db.prepare(`SELECT demo FROM companies WHERE id = ?1`).bind(companyId).first<{ demo: number }>();
    const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

    const ins = await db
      .prepare(
        `INSERT OR IGNORE INTO message_jobs
          (company_id, kind, booking_id, to_phone, template_code, language, payload_json,
           status, scheduled_at, fire_deadline, price_cents, cost_cents, capture_on, max_attempts,
           idempotency_key, demo, created_at, updated_at)
         VALUES (?1,?2,?3,?4,?5,?6,?7,'scheduled',?8,?9,?10,?11,?12,?13,?14,?15,?16,?16)`
      )
      .bind(
        companyId,
        kind,
        booking.id,
        normalizeBrPhone(booking.customer_phone),
        tpl.code,
        tpl.language,
        JSON.stringify({
          shop: settings.shop_name,
          customer: booking.customer_name,
          barber: booking.barber_name || "",
          service: booking.service_name || "",
          when: booking.starts_at,
          code: booking.code,
          template_body: inp.bodyPreview || tpl.body_text,
          tz: settings.timezone,
          manual: kind === "manual" || kind === "test",
        }),
        iso(fireAtMs),
        iso(fireDeadlineMs),
        price.price_cents,
        price.cost_cents,
        settings.capture_on,
        Number(platform.msg_max_attempts),
        idem,
        company?.demo ?? 0,
        nowIso()
      )
      .run();
    if (!ins.meta?.changes) return { ok: true, status: "scheduled", reason: "job já existia (idempotente)" };
    const jobId = ins.meta.last_row_id as number;

    // reserva do saldo (adianta conflito p/ o dono da barbearia já no agendamento)
    await ensureWallet(db, companyId);
    const r = await tryReserve(db, companyId, jobId, price.price_cents);
    if (!r) return { ok: true, status: "blocked_funds", jobId, reason: "saldo de créditos insuficiente — entra em espera e envia quando houver saldo" };
    return { ok: true, status: "scheduled", jobId };
  } catch (e) {
    return { ok: false, status: "skipped", reason: `falha ao programar mensagem: ${String(e).slice(0, 120)}` };
  }
}

async function tryReserve(db: D1Database, companyId: number, jobId: number, priceCents: number): Promise<boolean> {
  if (priceCents <= 0) return true; // regra zero = grátis; nada a reservar
  const wallet = await ensureWallet(db, companyId);
  const res = await reserveForJob(db, companyId, jobId, priceCents, wallet.allow_negative === 1);
  if (!res.ok) {
    await db.batch([
      db.prepare(`UPDATE message_jobs SET status='blocked_funds', last_error='saldo insuficiente', updated_at=?1 WHERE id=?2 AND status='scheduled'`).bind(nowIso(), jobId),
      notifyIfNoRecent(db, companyId, "billing", "Saldo de créditos baixo", "Um lembrete de WhatsApp ficou na fila por falta de créditos. Faça uma recarga para não perder envios."),
    ]);
    return false;
  }
  return true;
}

function notifyIfNoRecent(db: D1Database, companyId: number, kind: "billing" | "message" | "connection", title: string, body: string): D1PreparedStatement {
  return db.prepare(
    `INSERT INTO notifications (company_id, audience, title, body, kind)
     SELECT ?1,'admin',?2,?3,?4
     WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE company_id=?1 AND kind=?4 AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-6 hours'))`
  ).bind(companyId, title, body, kind);
}

/** Cancela jobs pendentes do agendamento (e libera reservas). */
export async function cancelPendingJobs(
  db: D1Database, companyId: number, bookingId: number,
  kind: MessageKind | null, reason: string, exceptIdempotencyKey?: string
): Promise<void> {
  const kindF = kind ? " AND kind = ?3" : "";
  const exceptF = exceptIdempotencyKey ? ` AND idempotency_key <> ?${kind ? 4 : 3}` : "";
  const { results } = await db
    .prepare(
      `SELECT id, reserved_cents FROM message_jobs
       WHERE company_id = ?1 AND booking_id = ?2${kindF}${exceptF} AND status IN ('scheduled','blocked_funds')`
    )
    .bind(companyId, bookingId, ...(kind ? [kind] : []), ...(exceptIdempotencyKey ? [exceptIdempotencyKey] : []))
    .all<{ id: number; reserved_cents: number }>();
  for (const j of results) {
    await db
      .prepare(`UPDATE message_jobs SET status='cancelled', last_error=?1, updated_at=?2 WHERE id=?3 AND status IN ('scheduled','blocked_funds')`)
      .bind(reason, nowIso(), j.id)
      .run();
    if (j.reserved_cents > 0) await releaseJobReservation(db, companyId, j.id, j.reserved_cents);
  }
}

/** Remarcou? bump da versão — jobs futuros usam nova chave; os velhos são caçados. */
export async function bumpBookingVersion(db: D1Database, bookingId: number): Promise<void> {
  await db.prepare(`UPDATE bookings SET schedule_version = schedule_version + 1, updated_at = ?2 WHERE id = ?1`).bind(bookingId, nowIso()).run();
}

// ── DISPATCH (cron a cada ~1 min; também chamado pelos testes) ──────────────
export interface DispatchResult {
  processed: number;
  sent: number;
  failed: number;
  blocked: number;
  skipped: number;
  retried: number;
}

export async function processDueJobs(env: Env, opts: { now?: Date; limit?: number; companyId?: number } = {}): Promise<DispatchResult> {
  const db = env.DB;
  const now = opts.now ?? new Date();
  const limit = Math.min(100, Math.max(1, opts.limit ?? 40));
  const out: DispatchResult = { processed: 0, sent: 0, failed: 0, blocked: 0, skipped: 0, retried: 0 };
  await sweepStuckJobs(db);

  const companyFilter = opts.companyId ? " AND j.company_id = ?2" : "";
  const { results } = await db
    .prepare(
      `SELECT j.*, c.status AS company_status, c.demo AS company_demo
       FROM message_jobs j JOIN companies c ON c.id = j.company_id
       WHERE j.status IN ('scheduled','blocked_funds') AND j.scheduled_at <= ?1${companyFilter}
         AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= ?1)
       ORDER BY j.scheduled_at ASC LIMIT ${limit}`
    )
    .bind(isoZ(now), ...(opts.companyId ? [opts.companyId] : []))
    .all<MessageJobRow>();

  for (const job of results) {
    out.processed++;
    try {
      await dispatchOne(env, job, now, out);
    } catch (e) {
      await db.prepare(`UPDATE message_jobs SET last_error = ?1, updated_at = ?2, status = 'scheduled', next_attempt_at = strftime('%Y-%m-%dT%H:%M:%SZ','now','+300 seconds') WHERE id = ?3 AND status = 'sending'`).bind(String(e).slice(0, 400), nowIso(), job.id).run();
    }
  }
  return out;
}

interface MessageJobRow {
  id: number;
  company_id: number;
  kind: string;
  booking_id: number | null;
  to_phone: string;
  template_code: string;
  language: string;
  payload_json: string;
  scheduled_at: string;
  fire_deadline: string;
  status: string;
  attempts: number;
  max_attempts: number;
  provider_msg_id: string;
  price_cents: number;
  cost_cents: number;
  capture_on: string;
  reserved_cents: number;
  last_error: string;
  company_status: string;
  company_demo: number;
}

async function dispatchOne(env: Env, job: MessageJobRow, now: Date, out: DispatchResult): Promise<void> {
  const db = env.DB;
  const platform = await loadPlatformSettings(db);

  // 1) prazo? agendamento cancelado/passado? → descarta e libera reserva
  const bookingActive = job.booking_id
    ? await db.prepare(`SELECT status, whatsapp_optin FROM bookings WHERE id = ?1 AND company_id = ?2`).bind(job.booking_id, job.company_id).first<{ status: string; whatsapp_optin: number }>()
    : null;
  const dead = now.getTime() > Date.parse(job.fire_deadline);
  if (dead || (job.booking_id != null && (!bookingActive || (bookingActive.status !== "pendente" && bookingActive.status !== "confirmado")))) {
    await db
      .prepare(`UPDATE message_jobs SET status='skipped', skip_reason=?1, last_error=?1, updated_at=?2 WHERE id=?3 AND status IN ('scheduled','blocked_funds')`)
      .bind(dead ? "fora do prazo de envio" : "agendamento cancelado/encerrado", nowIso(), job.id)
      .run();
    if (job.reserved_cents > 0) await releaseJobReservation(db, job.company_id, job.id, job.reserved_cents);
    out.skipped++;
    return;
  }
  if (bookingActive && !bookingActive.whatsapp_optin) {
    await db.prepare(`UPDATE message_jobs SET status='skipped', skip_reason='cliente sem opt-in', updated_at=?1 WHERE id=?2`).bind(nowIso(), job.id).run();
    if (job.reserved_cents > 0) await releaseJobReservation(db, job.company_id, job.id, job.reserved_cents);
    out.skipped++;
    return;
  }

  // 2) plano & conexão (re-validados no disparo)
  const plan = await db
    .prepare(`SELECT p.whatsapp_enabled, p.max_messages_month, c.demo FROM plans p JOIN subscriptions s ON s.plan_code = p.code JOIN companies c ON c.id = s.company_id WHERE s.company_id = ?1`)
    .bind(job.company_id)
    .first<{ whatsapp_enabled: number; max_messages_month: number; demo: number }>();
  const payload = JSON.parse(job.payload_json || "{}") as { manual?: boolean };
  const isManual = Boolean(payload.manual);
  if (!isManual && plan && plan.whatsapp_enabled !== 1) {
    await db.prepare(`UPDATE message_jobs SET status='skipped', skip_reason='plano sem WhatsApp', updated_at=?1 WHERE id=?2`).bind(nowIso(), job.id).run();
    if (job.reserved_cents > 0) await releaseJobReservation(db, job.company_id, job.id, job.reserved_cents);
    out.skipped++;
    return;
  }
  if (!isManual && plan && plan.max_messages_month > 0) {
    const monthStart = `${now.toISOString().slice(0, 7)}-01T00:00:00Z`;
    const used = await db
      .prepare(`SELECT COUNT(*) AS n FROM message_jobs WHERE company_id = ?1 AND captured_at IS NOT NULL AND captured_at >= ?2`)
      .bind(job.company_id, monthStart)
      .first<{ n: number }>();
    if ((used?.n ?? 0) >= plan.max_messages_month) {
      await db.batch([
        db.prepare(`UPDATE message_jobs SET status='blocked_funds', last_error='limite mensal do plano atingido', next_attempt_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','+3600 seconds'), updated_at=?1 WHERE id=?2`).bind(nowIso(), job.id),
        notifyIfNoRecent(db, job.company_id, "billing", "Limite mensal de mensagens do plano atingido", "Os envios ficarão em espera até o próximo ciclo ou upgrade do plano."),
      ]);
      out.blocked++;
      return;
    }
  }
  const conn = await getConnection(db, job.company_id);
  if (!conn || conn.status !== "connected") {
    await db
      .prepare(`UPDATE message_jobs SET last_error='conexão WhatsApp inativa', next_attempt_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','+300 seconds'), updated_at=?1 WHERE id=?2`)
      .bind(nowIso(), job.id)
      .run();
    out.blocked++;
    return;
  }

  // 3) reserva do saldo (bloqueados aguardam aqui)
  if (job.reserved_cents <= 0 && job.price_cents > 0) {
    const ok = await tryReserve(db, job.company_id, job.id, job.price_cents);
    if (!ok) {
      out.blocked++;
      return;
    }
  }

  // 4) claim (um só worker vence)
  const claim = await db
    .prepare(`UPDATE message_jobs SET status='sending', attempts=attempts+1, last_attempt_at=?1, updated_at=?1 WHERE id=?2 AND status IN ('scheduled','blocked_funds')`)
    .bind(nowIso(), job.id)
    .run();
  if (!claim.meta?.changes) return;

  // 5) provedor (FORA de qualquer batch — nada de fetch dentro de transação)
  const ctx: ProviderContext = { env: env as unknown as ProviderContext["env"], db, conn, demo: job.company_demo === 1 };
  const { provider, error } = await resolveProvider({ env: env as unknown as ProviderContext["env"], db, demo: job.company_demo === 1, conn });
  const vars = await renderTemplateVars(db, job);
  const result = provider
    ? await provider.sendTemplate(ctx, { to: job.to_phone, templateCode: job.template_code, language: job.language, variables: vars, wabaBizMetadata: { job_id: String(job.id) } })
    : { accepted: false, permanent: true, error: error || "provedor indisponível", providerMessageId: undefined as string | undefined };

  const at = nowIso();
  const outcome = result.accepted ? "accepted" : result.permanent ? "permanent_error" : "retryable_error";
  const attemptIns = db
    .prepare(`INSERT INTO message_attempts (job_id, n, outcome, http_status, error, at) VALUES (?1,?2,?3,NULL,?4,?5)`)
    .bind(job.id, job.attempts + 1, outcome, (result.error || result.providerMessageId || "").slice(0, 300), at);

  if (result.accepted) {
    await db.batch([
      attemptIns,
      db.prepare(`UPDATE message_jobs SET status='sent', provider_msg_id=?1, sent_at=?2, delivered_at=NULL, last_error='', updated_at=?2 WHERE id=?3 AND status='sending'`).bind(result.providerMessageId ?? "", at, job.id),
    ]);
    out.sent++;
    if (job.capture_on === "sent") {
      await captureJobCharge(db, job.company_id, job.id, job.price_cents);
      await maybeLowBalanceAlert(db, job.company_id);
    }
    return;
  }

  const attemptsLeft = job.attempts + 1 < (job.max_attempts || Number(platform.msg_max_attempts));
  if (!result.permanent && attemptsLeft) {
    const backoff = Number(platform.retry_backoff_sec) * Math.pow(2, job.attempts); // expoencial: 2,4,8…
    await db.batch([
      attemptIns,
      db.prepare(`UPDATE message_jobs SET status='scheduled', last_error=?1, next_attempt_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','+' || ?2 || ' seconds'), updated_at=?3 WHERE id=?4 AND status='sending'`).bind(String(result.error).slice(0, 400), backoff, at, job.id),
    ]);
    out.retried++;
    return;
  }

  // 6) falha definitiva → não cobra: libera reserva
  await db.batch([
    attemptIns,
    db.prepare(`UPDATE message_jobs SET status='failed', last_error=?1, updated_at=?2 WHERE id=?3 AND status='sending'`).bind(String(result.error).slice(0, 400), at, job.id),
    notifyIfNoRecent(db, job.company_id, "message", "Falha ao enviar mensagem de WhatsApp", `Motivo: ${String(result.error).slice(0, 160)}. O crédito NÃO foi cobrado.`),
  ]);
  if (job.reserved_cents > 0 || job.price_cents > 0) await releaseJobReservation(db, job.company_id, job.id, job.price_cents || job.reserved_cents);
  out.failed++;
}

/** variáveis {{1..6}} renderizadas a partir do booking (snapshot vivo) */
async function renderTemplateVars(db: D1Database, job: MessageJobRow): Promise<{ key: string; sample: string }[]> {
  const b = job.booking_id
    ? await db
        .prepare(`SELECT b.code, b.customer_name, b.starts_at, s.name AS service_name, br.name AS barber_name, c.name AS company_name
                  FROM bookings b JOIN companies c ON c.id = b.company_id
                  LEFT JOIN services s ON s.id = b.service_id LEFT JOIN barbers br ON br.id = b.barber_id
                  WHERE b.id = ?1 AND b.company_id = ?2`)
        .bind(job.booking_id, job.company_id)
        .first<{ code: string; customer_name: string; starts_at: string; service_name: string; barber_name: string; company_name: string }>()
    : null;
  const p = JSON.parse(job.payload_json || "{}") as Record<string, string>;
  const tz = p.tz || "America/Bahia";
  const when = b?.starts_at
    ? new Date(b.starts_at).toLocaleString("pt-BR", { timeZone: tz, weekday: "short", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
  return [
    { key: "1", sample: b?.customer_name ?? "" },
    { key: "2", sample: b?.service_name ?? "" },
    { key: "3", sample: b?.barber_name ?? "" },
    { key: "4", sample: when },
    { key: "5", sample: b?.company_name ?? "" },
    { key: "6", sample: b?.code ?? "" },
  ];
}

/** reconcilia jobs 'sending' que órfão por crash/timeout do Worker */
async function sweepStuckJobs(db: D1Database): Promise<void> {
  await db
    .prepare(`UPDATE message_jobs SET status='sent', last_error='reconciliado: aceito no provedor antes do timeout', sent_at=COALESCE(sent_at, ?1), updated_at=?1 WHERE status='sending' AND provider_msg_id <> '' AND last_attempt_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes')`)
    .bind(nowIso())
    .run();
  await db
    .prepare(`UPDATE message_jobs SET status='sending', last_error='Pendente de conferência: resposta desconhecida do provedor', updated_at=?1, next_attempt_at=strftime('%Y-%m-%dT%H:%M:%SZ','now','+60 seconds') WHERE status='sending' AND provider_msg_id = '' AND last_attempt_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes')`)
    .bind(nowIso())
    .run();
}

async function maybeLowBalanceAlert(db: D1Database, companyId: number): Promise<void> {
  const w = await ensureWallet(db, companyId);
  if (w.balance_cents - w.reserved_cents > w.low_balance_alert_cents) return;
  await db
    .prepare(
      `INSERT INTO notifications (company_id, audience, title, body, kind)
       SELECT ?1,'admin','Saldo baixo de créditos','Restam R$ ' || printf('%.2f', MAX(0,?2)/100.0) || ' livres para envio de WhatsApp. Faça uma recarga para não perder lembretes.','billing'
       WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE company_id=?1 AND kind='billing' AND created_at > strftime('%Y-%m-%dT%H:%M:%SZ','now','-12 hours'))`
    )
    .bind(companyId, w.balance_cents - w.reserved_cents)
    .run();
}

// ── WEBHOOK (status de entrega + recebidos) ─────────────────────────────────
export interface IngestResult {
  events: number;
  updated: number;
}

/**
 * Processa o payload do Meta. Idempotente por event_uid (UNIQUE): reentregas
 * do webhook não duplicam cobrança/estado. Retorno 200 rápido fica com a rota.
 */
export async function ingestWhatsappWebhook(env: Env, body: unknown): Promise<IngestResult> {
  const db = env.DB;
  let events = 0;
  let updated = 0;
  interface WValue { metadata?: { phone_number_id?: string }; contacts?: { profile?: { name?: string } }[]; messages?: { from?: string; id?: string; type?: string; text?: { body?: string } }[]; statuses?: { id?: string; status?: string; timestamp?: string; errors?: { code?: number; title?: string }[] }[] }
  const payload = body as { entry?: { changes?: { value?: WValue }[] }[] };
  const now = nowIso();

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const v = change.value;
      if (!v) continue;
      const pnId = v.metadata?.phone_number_id ?? "";
      const comp = pnId ? await db.prepare(`SELECT company_id FROM whatsapp_connections WHERE phone_number_id = ?1`).bind(pnId).first<{ company_id: number }>() : null;

      for (const st of v.statuses ?? []) {
        if (!st.id) continue;
        events++;
        const uid = `wa:status:${st.id}:${st.status}:${st.timestamp ?? ""}`;
        // A metadata.phone_number_id é o número receptor do webhook da Meta.
        // Nunca processe um status de outra barbearia, mesmo que seu message id exista.
        if (!comp) continue;
        const job = await db.prepare(
          `SELECT id, company_id, status, price_cents, capture_on, captured_at FROM message_jobs
           WHERE provider_msg_id = ?1 AND company_id = ?2`
        ).bind(st.id, comp.company_id).first<{ id: number; company_id: number; status: string; price_cents: number; capture_on: string; captured_at: string | null }>();
        if (!job) continue;
        const ins = await db
          .prepare(`INSERT OR IGNORE INTO message_webhook_events (company_id, job_id, event_uid, status, raw_json, processed, created_at) VALUES (?1,?2,?3,?4,?5,1,?6)`)
          .bind(comp.company_id, job.id, uid, st.status ?? "unknown", JSON.stringify(st), now)
          .run();
        if (!ins.meta?.changes) continue; // reentrega do webhook (idempotência)
        updated++;
        const status = st.status ?? "";
        if (status === "failed") {
          // Uma entrega já confirmada não pode regredir por webhook fora de ordem.
          if (job.status !== "sent") continue;
          const transition = await db.prepare(
            `UPDATE message_jobs SET status='failed', last_error=?1, updated_at=?2
             WHERE id=?3 AND company_id=?4 AND status='sent'`
          ).bind(st.errors?.[0]?.title || "falha reportada pelo WhatsApp", now, job.id, comp.company_id).run();
          if (!transition.meta?.changes) continue;
          if (job.captured_at) {
            await refundJobCharge(db, job.company_id, job.id, job.price_cents, "Falha de entrega pós-cobrança reportada pelo WhatsApp (estorno automático)");
          } else if (job.capture_on === "delivered") {
            await releaseJobReservation(db, job.company_id, job.id, job.price_cents);
          }
        } else if (status === "delivered") {
          const transition = await db.prepare(
            `UPDATE message_jobs SET status='delivered', delivered_at=?1, updated_at=?1
             WHERE id=?2 AND company_id=?3 AND status='sent'`
          ).bind(now, job.id, comp.company_id).run();
          if (transition.meta?.changes && job.capture_on === "delivered" && !job.captured_at) {
            await captureJobCharge(db, job.company_id, job.id, job.price_cents);
            await maybeLowBalanceAlert(db, job.company_id);
          }
        } else if (status === "read") {
          const transition = await db.prepare(
            `UPDATE message_jobs SET status='read', read_at=?1, updated_at=?1
             WHERE id=?2 AND company_id=?3 AND status IN ('sent','delivered')`
          ).bind(now, job.id, comp.company_id).run();
          if (transition.meta?.changes && job.capture_on === "delivered") {
            const j2 = await db.prepare(`SELECT captured_at, price_cents FROM message_jobs WHERE id=?1`).bind(job.id).first<{ captured_at: string | null; price_cents: number }>();
            if (!j2?.captured_at) await captureJobCharge(db, job.company_id, job.id, j2?.price_cents ?? job.price_cents);
          }
        } else if (status === "sent") {
          await db.prepare(`UPDATE message_jobs SET status='sent', sent_at=COALESCE(sent_at,?1), updated_at=?1 WHERE id=?2 AND status='sending'`).bind(now, job.id).run();
        }
      }

      // recebidas do cliente → notifica o painel (trilha crua p/ auditoria)
      for (const m of v.messages ?? []) {
        if (!m.id || !comp) continue;
        events++;
        const uid = `wa:in:${m.id}`;
        const ins = await db
          .prepare(`INSERT OR IGNORE INTO message_webhook_events (company_id, event_uid, status, raw_json, processed, created_at) VALUES (?1,?2,'received',?3,1,?4)`)
          .bind(comp.company_id, uid, JSON.stringify({ from: m.from, body: m.text?.body ?? `[${m.type}]`, at: now }), now)
          .run();
        if (ins.meta?.changes) {
          updated++;
          const fromDigits = (m.from || "").replace(/\D/g, "");
          const name = v.contacts?.[0]?.profile?.name ?? "Cliente";
          await db.batch([
            // Mensagem recebida NÃO equivale a consentimento para lembretes futuros.
            db.prepare(`INSERT INTO customers (company_id, name, phone, whatsapp_optin) VALUES (?1,?2,?3,0) ON CONFLICT(company_id, phone) DO UPDATE SET name = COALESCE(NULLIF(customers.name,''), excluded.name)`).bind(comp.company_id, name, fromDigits),
            notifyIfNoRecent(db, comp.company_id, "message", "Nova mensagem recebida no WhatsApp da barbearia", `${name}: ${String(m.text?.body ?? "").slice(0, 140)}`),
          ]);
        }
      }
    }
  }
  return { events, updated };
}

export function maskPhone(p: string): string {
  return p.length > 7 ? `${p.slice(0, 5)}••••${p.slice(-2)}` : "•••";
}
export function normalizeBrPhone(raw: string): string {
  let p = (raw || "").replace(/\D/g, "");
  p = p.replace(/^0+/, "");
  if (p.length === 10 || p.length === 11) p = `55${p}`;
  return p;
}
function isoZ(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Envio imediato de teste/manual — cobra a mesma tarifa vigente (idempotente). */
export async function sendImmediate(
  env: Env,
  companyId: number,
  opts: { to: string; templateCode: string; kind: MessageKind; bookingId?: number | null; test?: boolean }
): Promise<{ ok: boolean; error?: string; jobId?: number }> {
  const db = env.DB;
  if (!/^\d{10,15}$/.test(opts.to)) return { ok: false, error: "Número inválido (use DDI+DDD+numero, só dígitos)." };
  const now = new Date();
  const idem = `send-${opts.kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const price = await resolvePricing(db, companyId, opts.test ? "utility" : "utility");
  const company = await db.prepare(`SELECT demo FROM companies WHERE id = ?1`).bind(companyId).first<{ demo: number }>();
  const ins = await db
    .prepare(
      `INSERT INTO message_jobs (company_id, kind, booking_id, to_phone, template_code, language, payload_json, status, scheduled_at, fire_deadline,
        price_cents, cost_cents, capture_on, max_attempts, idempotency_key, demo, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,'pt_BR',?6,'scheduled',?7,?8,?9,?10,'sent',1,?11,?12,?13,?13)`
    )
    .bind(
      companyId,
      opts.kind,
      opts.bookingId ?? null,
      normalizeBrPhone(opts.to),
      opts.templateCode,
      JSON.stringify({ manual: true }),
      isoZ(now),
      isoZ(new Date(now.getTime() + 10 * 60_000)),
      price.price_cents,
      price.cost_cents,
      idem,
      company?.demo ?? 0,
      nowIso()
    )
    .run();
  const jobId = ins.meta.last_row_id as number;
  await processDueJobs(env, { now, limit: 100, companyId });
  const row = await db.prepare(`SELECT status, last_error FROM message_jobs WHERE id = ?1`).bind(jobId).first<{ status: string; last_error: string }>();
  if (!row) return { ok: false, error: "job desapareceu" };
  if (row.status === "sent" || row.status === "delivered" || row.status === "read") return { ok: true, jobId };
  if (row.status === "failed" || row.status === "skipped" || row.status === "cancelled") return { ok: false, error: row.last_error || `status ${row.status}`, jobId };
  return { ok: true, jobId, error: row.status === "blocked_funds" ? "saldo insuficiente — envio na fila de espera" : row.status === "scheduled" ? "na fila (aguardando próxima varredura)" : undefined };
}
