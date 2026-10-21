import { z } from "zod";
import { openingRangeSchema, timezoneSchema } from "./schedule-validation";
import { isValidPlatformSetting } from "./platform-setting-validation";

// ============================================================================
// Configurações POR EMPRESA (company_settings.data) + defaults DA PLATAFORMA
// (platform_settings). Todo valor editável no painel, validado por zod.
// ============================================================================

export const brandSchema = z.object({
  gold: z.string().regex(/^#([0-9a-fA-F]{6})$/, "Cor inválida (use #RRGGBB)"),
  ink: z.string().regex(/^#([0-9a-fA-F]{6})$/),
  panel: z.string().regex(/^#([0-9a-fA-F]{6})$/),
  line: z.string().regex(/^#([0-9a-fA-F]{6})$/),
});


export const companySettingsSchema = z.object({
  shop_name: z.string().min(2).max(80),
  tagline: z.string().max(120).default(""),
  about: z.string().max(1200).default(""),
  phone: z.string().max(30).default(""),
  whatsapp: z.string().max(20).refine((v) => v === "" || /^\d{10,15}$/.test(v), "Use somente números com DDI+DDD, ex.: 5575999990000").default(""),
  email: z.string().email("E-mail inválido").or(z.literal("")).default(""),
  address: z.string().max(200).default(""),
  maps_query: z.string().max(200).default(""),
  instagram: z.string().url("URL inválida").or(z.literal("")).default(""),
  facebook: z.string().url().or(z.literal("")).default(""),
  logo_url: z.string().max(500).default(""),
  banner_url: z.string().max(500).default(""),
  brand: brandSchema,
  opening_hours: z.record(z.string().regex(/^[0-6]$/, "Dia da semana inválido"), openingRangeSchema.nullable()),
  currency: z.literal("BRL").default("BRL"),
  timezone: timezoneSchema.default("America/Bahia"),
  // regras de agenda
  min_lead_min: z.number().int().min(0).max(2880).default(60),
  horizon_days: z.number().int().min(3).max(120).default(30),
  slot_step_min: z.number().int().min(5).max(120).default(15),
  allow_online_cancel: z.boolean().default(true),
  allow_online_reschedule: z.boolean().default(true),
  cancel_cutoff_min: z.number().int().min(0).max(10080).default(120),
  reschedule_cutoff_min: z.number().int().min(0).max(10080).default(120),
  cancel_policy_text: z.string().max(1500).default(""),
  code_prefix: z.string().regex(/^[A-Z0-9]{2,4}$/).default("TGU"),
  // permissões & módulos
  barber_can_conclude: z.boolean().default(true),
  barber_can_cancel: z.boolean().default(true),
  barber_can_block: z.boolean().default(true),
  reviews_enabled: z.boolean().default(true),
  products_enabled: z.boolean().default(true),
  whatsapp_buttons_enabled: z.boolean().default(true),
  // WhatsApp / mensagens (recursos financeiros SEMPRE validados no servidor)
  whatsapp_reminders_enabled: z.boolean().default(true),
  whatsapp_confirm_enabled: z.boolean().default(true),
  reminder_lead_min: z.number().int().min(0).max(24 * 60).default(60),
  /** agendamento criado já dentro da janela do lembrete: skip | send_immediate */
  short_lead_reminder_policy: z.enum(["skip", "send_immediate"]).default("skip"),
  /** captura do crédito: ao aceitar no provedor ou ao entregar */
  capture_on: z.enum(["sent", "delivered"]).default("sent"),
  reminder_template_code: z.string().max(60).default("tigu_lembrete"),
  confirm_template_code: z.string().max(60).default("tigu_confirmacao"),
});

export type CompanySettings = z.infer<typeof companySettingsSchema>;
/** alias histórico (motor de disponibilidade compartilhado) */
export type ShopSettings = CompanySettings;

export const DEFAULT_SETTINGS: CompanySettings = companySettingsSchema.parse({
  shop_name: "Barbearia",
  brand: { gold: "#d4af37", ink: "#0a0a0c", panel: "#16161c", line: "#26262f" },
  opening_hours: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [String(d), d === 0 ? null : { open: "09:00", close: "20:00" }])),
});

export const PUBLIC_SETTING_KEYS = [
  "shop_name", "tagline", "about", "phone", "whatsapp", "email", "address", "maps_query",
  "instagram", "facebook", "logo_url", "banner_url", "brand", "opening_hours", "currency",
  "timezone", "horizon_days", "min_lead_min", "slot_step_min", "allow_online_cancel",
  "allow_online_reschedule", "cancel_cutoff_min", "reschedule_cutoff_min", "cancel_policy_text",
  "reviews_enabled", "products_enabled", "whatsapp_buttons_enabled", "reminder_lead_min",
] as const;

/** merge defensivo: campos novos caem no default sem precisar de migração */
function mergeDefaults(parsed: Record<string, unknown>): CompanySettings {
  return companySettingsSchema.parse({ ...structuredCloneSafe(DEFAULT_SETTINGS), ...parsed });
}
function structuredCloneSafe<T>(v: T): T {
  return JSON.parse(JSON.stringify(v));
}

export async function loadCompanySettings(db: D1Database, companyId: number): Promise<CompanySettings> {
  const row = await db.prepare("SELECT data FROM company_settings WHERE company_id = ?1").bind(companyId).first<{ data: string }>();
  if (!row) return DEFAULT_SETTINGS;
  try {
    return mergeDefaults(JSON.parse(row.data));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveCompanySettings(db: D1Database, companyId: number, values: CompanySettings): Promise<void> {
  await db
    .prepare(`INSERT INTO company_settings (company_id, data, updated_at) VALUES (?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(company_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
    .bind(companyId, JSON.stringify(values))
    .run();
}

export function publicSettings(s: CompanySettings): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of PUBLIC_SETTING_KEYS) out[k] = s[k as keyof CompanySettings];
  return out;
}

// ── plataforma (superadmin) ─────────────────────────────────────────────────
export const platformDefaults = {
  msg_price_cents: 10,
  msg_cost_cents: 5,
  capture_on: "sent" as const,
  msg_max_attempts: 3,
  retry_backoff_sec: 120,
  topup_min_cents: 1000,
  topup_max_cents: 500000,
  low_balance_alert_cents: 300,
  reminder_lead_min: 60,
};
export type PlatformKey = keyof typeof platformDefaults;

const platformCache = { at: 0, data: { ...platformDefaults } as Record<PlatformKey, number | string> };

export async function loadPlatformSettings(db: D1Database, ttlMs = 10_000): Promise<Record<PlatformKey, number | string>> {
  const now = Date.now();
  if (now - platformCache.at < ttlMs) return platformCache.data;
  const { results } = await db.prepare("SELECT key, value FROM platform_settings").all<{ key: string; value: string }>();
  const data = { ...platformDefaults } as Record<PlatformKey, number | string>;
  for (const r of results) {
    if (!Object.prototype.hasOwnProperty.call(data, r.key)) continue;
    const key = r.key as PlatformKey;
    // Não transformar "", "NaN", Infinity ou decimais em valores financeiros.
    const parsed = typeof platformDefaults[key] === "number"
      && typeof r.value === "string" && /^(?:0|[1-9]\d*)$/.test(r.value)
      ? Number(r.value) : r.value;
    if (!isValidPlatformSetting(key, parsed)) {
      throw new Error("Configuração financeira inválida: " + key);
    }
    data[key] = parsed;
  }
  if (Number(data.topup_min_cents) > Number(data.topup_max_cents)) {
    throw new Error("Limites de recarga incompatíveis na plataforma");
  }
  platformCache.at = now;
  platformCache.data = data;
  return data;
}

export async function setPlatformSetting(db: D1Database, key: PlatformKey, value: number | string): Promise<boolean> {
  if (!isValidPlatformSetting(key, value)) return false;
  // A condição de consistência roda no MESMO comando SQL da gravação:
  // duas escritas simultâneas não podem deixar min > max.
  const otherKey = key === "topup_min_cents" ? "topup_max_cents"
    : key === "topup_max_cents" ? "topup_min_cents" : null;
  const defaultOther = otherKey === "topup_max_cents" ? platformDefaults.topup_max_cents
    : otherKey === "topup_min_cents" ? platformDefaults.topup_min_cents : 0;
  const result = await db.prepare(`INSERT INTO platform_settings (key, value, updated_at)
    SELECT ?1, ?2, strftime('%Y-%m-%dT%H:%M:%SZ','now')
    WHERE ?3 IS NULL OR EXISTS (
      SELECT 1 FROM (SELECT COALESCE(
        (SELECT CASE WHEN value <> '' AND value NOT GLOB '*[^0-9]*'
          AND LENGTH(value) <= 9 AND CAST(value AS INTEGER) BETWEEN 1 AND 100000000
          THEN CAST(value AS INTEGER) ELSE -1 END
          FROM platform_settings WHERE key=?3), ?4) AS opposite)
      WHERE opposite BETWEEN 1 AND 100000000
        AND ((?1='topup_min_cents' AND CAST(?2 AS INTEGER) <= opposite)
          OR (?1='topup_max_cents' AND CAST(?2 AS INTEGER) >= opposite))
    )
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(key, String(value), otherKey, defaultOther).run();
  if (result.success === false || result.meta?.changes !== 1) return false;
  platformCache.at = 0;
  return true;
}

export const platformSettingKeys = Object.keys(platformDefaults) as PlatformKey[];
