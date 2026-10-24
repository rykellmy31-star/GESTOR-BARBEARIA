// ============================================================================
// MOTOR DE DISPONIBILIDADE — fonte única da verdade para agenda pública,
// validação no servidor, reschedule e painel administrativo.
//
// Regras implementadas (todas lidas do banco, nada fixo no frontend):
//  - grade de horários por `slot_step_min` a partir do início do expediente
//  - expediente próprio por barbeiro (work_days / work_start / work_end)
//  - intervalo de almoço por barbeiro (break_start / break_end)
//  - folgas, férias e feriados (blocked_days — por barbeiro ou global)
//  - bloqueios de horário (bookings com status 'bloqueio')
//  - antecedência mínima (min_lead_min) para o dia de hoje
//  - horizonte máximo (horizon_days) e dias futuros válidos
//  - duração REAL do serviço (um serviço de 60 min ocupa 4 slots de 15)
//  - horários ocupados/removidos nunca aparecem como disponíveis
// ============================================================================

import { formatHHMM, localToUtc, overlaps, parseHHMM, todayLocal, utcToLocal, addDays } from "./time";
import { nowIso } from "./utils";
import type { ShopSettings } from "./settings";

export interface BarberRow {
  id: number;
  name: string;
  work_days: string; // JSON [0..6]
  work_start: string;
  work_end: string;
  break_start: string;
  break_end: string;
  active: number;
}

export interface ServiceRow {
  id: number;
  name: string;
  duration_min: number;
  price_cents: number;
}

/** O tempo personalizado pertence ao vínculo serviço+profissional.
 * Sem preferência cadastrada, mantém a duração original da barbearia. */
export async function effectiveServiceDuration(db: D1Database, barberId: number, service: ServiceRow): Promise<number> {
  const linked = await db.prepare(`SELECT sb.duration_override_min AS minutes
    FROM service_barbers sb
    JOIN barbers b ON b.id=sb.barber_id
    JOIN services s ON s.id=sb.service_id AND s.company_id=b.company_id
    WHERE sb.barber_id=?1 AND sb.service_id=?2`)
    .bind(barberId, service.id).first<{ minutes: number | null }>();
  return linked?.minutes ?? service.duration_min;
}

export interface DaySlot {
  /** Instante inicial em UTC ISO */
  t: string;
  /** Rótulo local HH:MM */
  label: string;
  available: boolean;
  /** motivo quando indisponível */
  reason?: "ocupado" | "passado" | "antecedencia" | "almoco" | "fora_expediente";
  booking_id?: number;
  booking_status?: string;
  booking_label?: string;
}

export interface DayResult {
  ok: boolean;
  day: string;
  weekday: number;
  closed_reason?: "dia_off" | "barbearia_fechada" | "fora_intervalo" | "barbeiro_inativo";
  slots: DaySlot[];
}

interface BusyInterval {
  a: number; // ms
  b: number;
  id: number;
  status: string;
  label: string;
}

async function loadBusyIntervals(db: D1Database, barberId: number, dayFrom: string, dayTo: string, tz: string, excludeBookingId?: number): Promise<BusyInterval[]> {
  // Janela UTC com folga de ±2 dias para cobrir deslocamento do fuso
  const start = localToUtc(tz, dayFrom, 0).getTime() - 48 * 3600_000;
  const end = localToUtc(tz, dayTo, 24 * 60 - 1).getTime() + 48 * 3600_000;
  const sql = `
    SELECT b.id, b.starts_at, b.ends_at, b.status, s.name AS service_name, b.customer_name, b.origin
    FROM bookings b LEFT JOIN services s ON s.id = b.service_id
    WHERE b.barber_id = ?1
      AND b.starts_at < ?3 AND b.ends_at > ?2
      AND b.status IN ('pendente','confirmado','no_show','bloqueio')
      ${excludeBookingId ? "AND b.id != " + excludeBookingId : ""}
  `;
  const { results } = await db.prepare(sql).bind(barberId, new Date(start).toISOString(), new Date(end).toISOString()).all<
    { id: number; starts_at: string; ends_at: string; status: string; service_name: string; customer_name: string; origin: string }
  >();
  return results.map((r) => ({
    a: Date.parse(r.starts_at),
    b: Date.parse(r.ends_at),
    id: r.id,
    status: r.status,
    label: r.status === "bloqueio" ? `Bloqueio (${r.origin === "barbeiro" ? "barbeiro" : "admin"})` : `${r.service_name} — ${r.customer_name}`,
  }));
}

export async function isDayBlocked(db: D1Database, barberId: number, day: string): Promise<{ blocked: boolean; kind?: string; reason?: string }> {
  const row = await db
    .prepare(
      `SELECT kind, reason FROM blocked_days
       WHERE company_id = (SELECT company_id FROM barbers WHERE id=?1)
         AND (barber_id = ?1 OR barber_id IS NULL) AND date_from <= ?2 AND date_to >= ?2
       ORDER BY (barber_id IS NULL) DESC LIMIT 1`
    )
    .bind(barberId, day)
    .first<{ kind: string; reason: string }>();
  return row ? { blocked: true, kind: row.kind, reason: row.reason } : { blocked: false };
}

/**
 * Calcula a grade completa de um dia para (barbeiro, serviço).
 * `mode=public`: retorna apenas slots realmente disponíveis + motivos para UI.
 * `mode=admin`: inclui ocupados com identificação (para agenda do painel).
 */
export async function computeDaySlots(
  db: D1Database,
  opts: { barber: BarberRow; service: ServiceRow; day: string; settings: ShopSettings; mode?: "public" | "admin"; now?: Date; excludeBookingId?: number; stepOverrideMin?: number; fixedDurationMin?: number }
): Promise<DayResult> {
  const s = opts.settings;
  const tz = s.timezone;
  const day = opts.day;
  const now = opts.now ?? new Date();
  const parsedDay = new Date(`${day}T12:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(parsedDay.getTime()) || parsedDay.toISOString().slice(0,10)!==day)
    return { ok:false, day, weekday:-1, slots:[], closed_reason:"fora_intervalo" };
  const empty: DayResult = { ok: false, day, weekday: utcToLocal(tz, new Date(`${day}T12:00:00Z`)).weekday, slots: [] };

  if (!opts.barber.active) return { ...empty, closed_reason: "barbeiro_inativo" };

  const workDays: number[] = safeJsonArray(opts.barber.work_days);
  const { weekday } = utcToLocal(tz, new Date(`${day}T12:00:00Z`));
  if (!workDays.includes(weekday)) return { ...empty, closed_reason: "dia_off" };

  const blocked = await isDayBlocked(db, opts.barber.id, day);
  if (blocked.blocked) return { ...empty, closed_reason: blocked.kind === "holiday" ? "barbearia_fechada" : "dia_off" };

  const open = s.opening_hours?.[String(weekday)];
  if (!open) return { ...empty, closed_reason: "barbearia_fechada" };

  const workStart = Math.max(parseHHMM(opts.barber.work_start), parseHHMM(open.open));
  const workEnd = Math.min(parseHHMM(opts.barber.work_end), parseHHMM(open.close));
  const breakA = parseHHMM(opts.barber.break_start);
  const breakB = parseHHMM(opts.barber.break_end);
  const duration = opts.fixedDurationMin ?? await effectiveServiceDuration(db,opts.barber.id,opts.service);
  const step = opts.stepOverrideMin ?? Math.max(5, s.slot_step_min);

  if (workEnd - workStart < duration) return { ...empty, closed_reason: "fora_intervalo" };

  const todayStr = utcToLocal(tz,now).day;
  const isToday = day === todayStr;
  if (day < todayStr) return { ...empty, closed_reason: "fora_intervalo" };
  const horizonEnd = addDays(todayStr, Math.max(1, s.horizon_days));
  if (day > horizonEnd) return { ...empty, closed_reason: "fora_intervalo" };

  const busy = await loadBusyIntervals(db, opts.barber.id, day, day, tz, opts.excludeBookingId);

  // Mantém a grade configurada e abre também o instante exato ao fim de
  // cada atendimento (ex.: corte 09h10-09h50 oferece 09h50).
  const candidates = new Set<number>();
  for (let m=workStart; m+duration<=workEnd; m+=step) candidates.add(m);
  for (const interval of busy) {
    const endLocal=utcToLocal(tz,new Date(interval.b));
    if(endLocal.day===day) {
      const next=Math.ceil(endLocal.minutes/5)*5;
      if(next>=workStart&&next+duration<=workEnd)candidates.add(next);
    }
  }
  // A conclusão antecipada abre a vaga liberada em múltiplos de 5 minutos.
  const released=await db.prepare(`SELECT ends_at FROM bookings
    WHERE barber_id=?1 AND status='concluido' AND actual_finished_at IS NOT NULL
      AND scheduled_ends_at>ends_at AND ends_at>=?2 AND ends_at<?3`)
    .bind(opts.barber.id,localToUtc(tz,day,0).toISOString(),
      localToUtc(tz,addDays(day,1),0).toISOString()).all<{ends_at:string}>();
  for(const done of released.results) {
    const endLocal=utcToLocal(tz,new Date(done.ends_at));
    if(endLocal.day===day&&endLocal.minutes>=workStart&&endLocal.minutes+duration<=workEnd)
      candidates.add(endLocal.minutes);
  }

  const slots: DaySlot[] = [];
  for (const m of [...candidates].sort((a,b)=>a-b)) {
    const startMs = localToUtc(tz, day, m).getTime();
    const endMs = localToUtc(tz, day, m + duration).getTime();
    const label = formatHHMM(m);
    const base = { t: new Date(startMs).toISOString().replace(/\.\d{3}Z$/, "Z"), label };

    if (startMs <= now.getTime()) {
      slots.push({ ...base, available: false, reason: "passado" });
      continue;
    }
    if (isToday && startMs < now.getTime() + s.min_lead_min * 60000) {
      slots.push({ ...base, available: false, reason: "antecedencia" });
      continue;
    }
    if (overlaps(m, m + duration, breakA, breakB)) {
      slots.push({ ...base, available: false, reason: "almoco" });
      continue;
    }
    const conflict = busy.find((bi) => overlaps(startMs, endMs, bi.a, bi.b));
    if (conflict) {
      slots.push({ ...base, available: false, reason: "ocupado", booking_id: conflict.id, booking_status: conflict.status, booking_label: conflict.label });
      continue;
    }
    slots.push({ ...base, available: true });
  }

  if (opts.mode === "public") {
    return { ok: true, day, weekday, slots: slots.filter((x) => x.available) };
  }
  return { ok: true, day, weekday, slots };
}

/** Slots de grade (chaves de trava) para um intervalo de reserva. */
export function slotKeysFor(startsAtIso: string, endsAtIso: string, stepMin: number): string[] {
  const a = Date.parse(startsAtIso);
  const b = Date.parse(endsAtIso);
  const keys: string[] = [];
  for (let t = a; t < b; t += stepMin * 60000) {
    const d = new Date(t);
    keys.push(d.toISOString().slice(0, 16).replace("T", " "));
  }
  return [...new Set(keys)];
}

/** Validação no servidor usada por create/reschedule. */
export async function assertSlotAllowed(
  db: D1Database,
  opts: {
    barber: BarberRow;
    service: ServiceRow;
    startsAt: string; // UTC ISO
    settings: ShopSettings;
    origin: "cliente" | "admin" | "barbeiro";
    excludeBookingId?: number;
    fitInDurationMin?: number;
  }
): Promise<{ ok: true; startsAt: string; endsAt: string } | { ok: false; error: string; status: number }> {
  const { settings: s, barber, service } = opts;
  const tz = s.timezone;
  const startMs = Date.parse(opts.startsAt);
  if (!Number.isFinite(startMs)) return { ok: false, error: "Data/hora inválida", status: 400 };
  const { day } = utcToLocal(tz, new Date(startMs));
  if(opts.origin==="barbeiro"&&startMs<=Date.now())
    return {ok:false,error:"Não é possível encaixar cliente em horário que já passou.",status:409};
  const local = utcToLocal(tz, new Date(startMs));
  const standardDuration=await effectiveServiceDuration(db,barber.id,service);
  if(opts.fitInDurationMin!=null && (
    opts.origin==="cliente" || !Number.isInteger(opts.fitInDurationMin) ||
    opts.fitInDurationMin<5 || opts.fitInDurationMin>Math.min(standardDuration,180) ||
    opts.fitInDurationMin%5!==0 || local.minutes%5!==0
  ))return {ok:false,error:"Encaixe inválido: duração deve caber no serviço e usar incrementos de 5 minutos.",status:422};
  const actualService={...service,duration_min:opts.fitInDurationMin??standardDuration};
  const endMs = startMs + actualService.duration_min * 60000;
  const endsAt = new Date(endMs).toISOString().replace(/\.\d{3}Z$/, "Z");

  if (!barber.active) return { ok: false, error: "Este barbeiro não está recebendo agendamentos", status: 409 };

  const result = await computeDaySlots(db, {
    barber,
    service:actualService,
    day,
    settings:s,
    mode:"admin",
    now:new Date(),
    excludeBookingId:opts.excludeBookingId,
    stepOverrideMin: opts.fitInDurationMin==null?undefined:5,
    fixedDurationMin:actualService.duration_min,
  });
  if (!result.ok || !result.slots.length) {
    return { ok: false, error: reasonClosed(result.closed_reason), status: 409 };
  }

  if (opts.origin === "cliente") {
    if (local.minutes + actualService.duration_min > parseHHMM(barber.work_end)) return { ok: false, error: "O serviço ultrapassaria o fim do expediente", status: 409 };
  }

  const match = result.slots.find((x) => x.t === opts.startsAt);
  if (!match) return { ok: false, error: "Horário fora do expediente do profissional", status: 409 };
  if (opts.origin === "cliente") {
    if (match.reason === "passado") return { ok: false, error: "Este horário já passou", status: 400 };
    if (match.reason === "antecedencia")
      return { ok: false, error: `Para hoje é necessária antecedência mínima de ${s.min_lead_min} minutos`, status: 409 };
  }
  if (match.reason === "almoco") return { ok: false, error: "Horário coincide com o intervalo de almoço", status: 409 };
  if (match.reason === "ocupado") return { ok: false, error: "Horário indisponível — já reservado ou bloqueado", status: 409 };

  // overlap final contra qualquer reserva ativa (cobre admin: tempos fora da grade)
  const busy = await loadBusyIntervals(db, barber.id, day, day, tz, opts.excludeBookingId);
  const clash = busy.find((bi) => overlaps(startMs, endMs, bi.a, bi.b));
  if (clash) return { ok: false, error: "Conflito de agenda: horário já ocupado por outra reserva", status: 409 };

  return { ok: true, startsAt: opts.startsAt, endsAt };
}

function reasonClosed(r?: string): string {
  switch (r) {
    case "dia_off":
      return "O profissional não trabalha neste dia (folga/férias/bloqueio)";
    case "barbearia_fechada":
      return "A barbearia está fechada neste dia";
    case "barbeiro_inativo":
      return "Este barbeiro não está recebendo agendamentos";
    default:
      return "Sem horários neste dia";
  }
}

function safeJsonArray(v: string): number[] {
  try {
    const arr = JSON.parse(v);
    return Array.isArray(arr) ? arr.filter((x) => Number.isInteger(x)) : [];
  } catch {
    return [];
  }
}

/** Resumo de ocupação do mês (para pontinhos no calendário do cliente). */
export async function monthSummary(
  db: D1Database,
  opts: { barber: BarberRow; service: ServiceRow | null; month: string; settings: ShopSettings }
): Promise<{ day: string; status: "none" | "day_off" | "partial" | "full" }[]> {
  const s = opts.settings;
  const tz = s.timezone;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(opts.month)) return [];
  const [y, m] = opts.month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const today = todayLocal(tz);
  const horizon = addDays(today, s.horizon_days);

  const out: { day: string; status: "none" | "day_off" | "partial" | "full" }[] = [];
  // Otimização: pega todos os bookings do mês em 1 query
  const first = `${y}-${String(m).padStart(2, "0")}-01`;
  const last = `${y}-${String(m).padStart(2, "0")}-${String(daysInMonth).padStart(2, "0")}`;
  const busyByDay = new Map<number, { id: number; starts_at: string; ends_at: string; status: string }[]>();
  if (opts.barber.active) {
    const startMs = localToUtc(tz, first, 0).getTime() - 48 * 3600_000;
    const endMs = localToUtc(tz, last, 1439).getTime() + 48 * 3600_000;
    const { results } = await db
      .prepare(
        `SELECT id, starts_at, ends_at, status FROM bookings
         WHERE barber_id = ?1 AND status IN ('pendente','confirmado','no_show','bloqueio')
           AND starts_at < ?3 AND ends_at > ?2`
      )
      .bind(opts.barber.id, new Date(startMs).toISOString(), new Date(endMs).toISOString())
      .all<{ id: number; starts_at: string; ends_at: string; status: string }>();
    for (const r of results) {
      const { day } = utcToLocal(tz, new Date(r.starts_at));
      const dkey = parseInt(day.slice(8, 10), 10);
      busyByDay.set(dkey, [...(busyByDay.get(dkey) || []), r]);
    }
  }

  for (let d = 1; d <= daysInMonth; d++) {
    const day = `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    if (day < today || day > horizon || !opts.service || !opts.barber.active) {
      out.push({ day, status: "none" });
      continue;
    }
    const workDays = safeJsonArray(opts.barber.work_days);
    const { weekday } = utcToLocal(tz, new Date(`${day}T12:00:00Z`));
    if (!workDays.includes(weekday) || (opts.settings.opening_hours?.[String(weekday)] == null)) {
      out.push({ day, status: "day_off" });
      continue;
    }
    const blocked = await isDayBlocked(db, opts.barber.id, day);
    if (blocked.blocked) {
      out.push({ day, status: "day_off" });
      continue;
    }
    // conta slots livres de forma simplificada (grade cheia - ocupados)
    const busy = busyByDay.get(d) || [];
    const open = opts.settings.opening_hours?.[String(weekday)]!;
    const workStart = Math.max(parseHHMM(opts.barber.work_start), parseHHMM(open.open));
    const workEnd = Math.min(parseHHMM(opts.barber.work_end), parseHHMM(open.close));
    const step = Math.max(5, s.slot_step_min);
    const duration = await effectiveServiceDuration(db,opts.barber.id,opts.service);
    const breakA = parseHHMM(opts.barber.break_start);
    const breakB = parseHHMM(opts.barber.break_end);
    const now = new Date();
    let free = 0;
    for (let mm = workStart; mm + duration <= workEnd; mm += step) {
      const st = localToUtc(tz, day, mm).getTime();
      const en = st + duration * 60000;
      if (st <= now.getTime()) continue;
      if (day === today && st < now.getTime() + s.min_lead_min * 60000) continue;
      if (overlaps(mm, mm + duration, breakA, breakB)) continue;
      if (busy.some((b) => overlaps(st, en, Date.parse(b.starts_at), Date.parse(b.ends_at)))) continue;
      free++;
    }
    out.push({ day, status: free === 0 ? "full" : "partial" });
  }
  return out;
}
