import type { ShopSettings } from "./types";

export function money(cents: number, settings?: Pick<ShopSettings, "currency">): string {
  return (cents / 100).toLocaleString("pt-BR", { style: "currency", currency: settings?.currency || "BRL" });
}

/** R$ reais → centavos (formulários de preço do painel) */
export function toCents(reais: number | string): number {
  return Math.round(Number(String(reais).replace(",", ".")) * 100) || 0;
}

/** "HH:MM" → minutos da meia-noite (blocos de agenda) */
export function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
export function fromMinutes(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

/** Offset (min) do fuso tz no instante dado — sem dependências externas. */
export function tzOffsetMin(tz: string, whenMs: number): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(whenMs))
      .map((x) => [x.type, x.value])
  );
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +(+p.hour % 24), +p.minute, +p.second);
  return Math.round((asUtc - whenMs) / 60000);
}

/** data local (YYYY-MM-DD) + hora local (HH:MM) → ISO UTC "…THH:MM:00Z" no fuso da barbearia */
export function localToUtcIso(tz: string, day: string, hhmm: string): string {
  const guess = Date.parse(`${day}T${hhmm}:00Z`);
  let t = guess - tzOffsetMin(tz, guess) * 60000;
  t = guess - tzOffsetMin(tz, t) * 60000; // refina (DST); Bahia não tem, mas é geral
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** ISO UTC → { day, hhmm } local no fuso (pré-preencher formulários) */
export function utcToLocalParts(tz: string, iso: string): { day: string; hhmm: string } {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { day: `${p.year}-${p.month}-${p.day}`, hhmm: `${+p.hour % 24 < 10 ? "0" : ""}${+p.hour % 24}:${p.minute}` };
}

const WEEKDAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
export const weekdayShort = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
export const MONTHS = ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];

export function weekdayName(i: number): string {
  return WEEKDAYS[((i % 7) + 7) % 7];
}

/** "2026-10-17T12:30:00Z" -> "Sáb, 17 de out · 09:30" (usa fuso da barbearia) */
export function fmtDateTime(iso: string, tz = "America/Bahia"): string {
  const d = new Date(iso);
  const local = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
  return local.replace(/\./g, "");
}

export function fmtTime(iso: string, tz = "America/Bahia"): string {
  return new Intl.DateTimeFormat("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

export function fmtDayLong(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.toLocaleDateString("pt-BR", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long" });
}

/** dia local "YYYY-MM-DD" (mesmo se agora for UTC) */
export function localDay(tz = "America/Bahia", date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "0";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

export function maskPhone(v: string): string {
  const d = v.replace(/\D/g, "").slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

/** gera/retorna chave de idempotência estável p/ sessão do wizard */
export function wizardKey(): string {
  let k = sessionStorage.getItem("tigu_wizard_key");
  if (!k) {
    k = crypto.randomUUID();
    sessionStorage.setItem("tigu_wizard_key", k);
  }
  return k;
}
