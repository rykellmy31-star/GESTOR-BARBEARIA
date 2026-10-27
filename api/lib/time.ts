// ============================================================================
// Utilitários de data/hora com fuso horário (o runtime do Workers tem ICU
// completo, então Intl.DateTimeFormat com `timeZone` funciona no D1/Worker).
//
// Convenções do projeto:
//  - Timestamps absolutos: UTC ISO-8601 "YYYY-MM-DDTHH:MM:SSZ"
//  - "Dias" de agenda/escala: string local "YYYY-MM-DD" no fuso da barbearia
//  - "HH:MM" de trabalho/grade: minutos locais desde 00:00
// ============================================================================

export function tzOffsetMinutes(timeZone: string, utc: Date): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(utc)) {
    if (p.type !== "literal") parts[p.type] = parseInt(p.value, 10);
  }
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  const ms = Math.floor(utc.getTime() / 1000) * 1000;
  return Math.round((asUtc - ms) / 60000);
}

/** Converte (dia local, minutos do dia) -> Instant UTC. Itera para corrigir DST. */
export function localToUtc(timeZone: string, day: string, minutes: number): Date {
  const [y, m, d] = day.split("-").map(Number);
  let utcMs = Date.UTC(y, m - 1, d, 0, minutes, 0);
  for (let i = 0; i < 3; i++) {
    const off = tzOffsetMinutes(timeZone, new Date(utcMs));
    const next = Date.UTC(y, m - 1, d, 0, minutes, 0) - off * 60000;
    if (next === utcMs) break;
    utcMs = next;
  }
  return new Date(utcMs);
}

export interface LocalInstant {
  day: string;      // "YYYY-MM-DD" local
  minutes: number;  // minutos desde 00:00 local (0..1439)
  weekday: number;  // 0=Dom .. 6=Sáb (do dia local)
}

export function utcToLocal(timeZone: string, date: Date | string): LocalInstant {
  const d = typeof date === "string" ? new Date(date) : date;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts: Record<string, number> = {};
  for (const p of dtf.formatToParts(d)) {
    if (p.type !== "literal") parts[p.type] = parseInt(p.value, 10);
  }
  const day = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const minutes = (parts.hour % 24) * 60 + parts.minute;
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return { day, minutes, weekday };
}

export function todayLocal(timeZone: string): string {
  return utcToLocal(timeZone, new Date()).day;
}

export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

export function formatHHMM(minutes: number): string {
  const h = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

export function parseHHMM(v: string): number {
  const [h, m] = (v || "0:0").split(":").map((x) => parseInt(x, 10));
  return clampMin((h || 0) * 60 + (m || 0));
}

export function clampMin(v: number): number {
  return Math.min(1439, Math.max(0, Math.round(v)));
}

/** Rótulo completo pt-BR: "sex, 17/10/2025 · 14:30" */
export function formatDateTimePtBr(timeZone: string, iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { timeZone, weekday: "short", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

export function formatDayPtBr(timeZone: string, day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "short", day: "2-digit", month: "2-digit" });
}

/** Intervalo [a1,a2) e [b1,b2) se sobrepõem? */
export function overlaps(a1: number, a2: number, b1: number, b2: number): boolean {
  return a1 < b2 && b1 < a2;
}
