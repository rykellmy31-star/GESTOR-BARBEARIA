import { z } from "zod";
import { sha256hex } from "./crypto";
import { nowIso } from "./utils";

export const leadRequestSchema = z.object({
  contact_name: z.string().trim().min(2).max(90),
  company_name: z.string().trim().min(3).max(100),
  email: z.string().trim().email().max(160).transform(v => v.toLowerCase()),
  phone: z.string().trim().min(10).max(30)
    .transform(v => v.replace(/[^0-9]/g, ""))
    .refine(v => /^[1-9][0-9]{9,14}$/.test(v), "Informe DDD e telefone, preferencialmente com DDI 55."),
  plan_code: z.enum(["pro", "scale"]),
  message: z.string().trim().max(600).default(""),
  consent: z.literal(true),
  turnstile_token: z.string().max(2048).default(""),
  website: z.string().max(120).default(""), // honeypot: clientes legítimos não preenchem
}).strict();

export const leadUpdateSchema = z.object({
  status: z.enum(["new", "contacted", "negotiating", "closed"]),
  internal_note: z.string().trim().max(500),
}).strict();

export type LeadRequest = z.infer<typeof leadRequestSchema>;
export type LeadStatus = z.infer<typeof leadUpdateSchema>["status"];

export interface SalesLeadRow {
  id: number;
  contact_name: string;
  company_name: string;
  email: string;
  phone: string;
  plan_code: "pro" | "scale";
  price_snapshot_cents: number;
  message: string;
  status: LeadStatus;
  internal_note: string;
  consent_at: string;
  created_at: string;
  updated_at: string;
}

/** Persiste bloqueio de 5 tentativas por hora; a origem fica apenas em hash. */
export async function allowSalesLeadAttempt(
  db: D1Database,
  secret: string,
  ip: string | null,
  email: string,
  time = Date.now()
): Promise<boolean> {
  const hourBucket = Math.floor(time / 3_600_000);
  const fingerprint = await sha256hex(`tigu-lead:${secret}:${ip || "email:" + email}`);
  const result = await db.prepare(
    `INSERT INTO sales_lead_rate_limits(fingerprint,hour_bucket,attempts) VALUES (?1,?2,1)
     ON CONFLICT(fingerprint,hour_bucket) DO UPDATE SET attempts=attempts+1
     WHERE attempts<5 RETURNING attempts`
  ).bind(fingerprint, hourBucket).first<{ attempts: number }>();
  return Boolean(result && result.attempts <= 5);
}

export async function createSalesLead(db: D1Database, data: LeadRequest, time = Date.now()) {
  const plan = await db.prepare(
    "SELECT price_cents_month FROM plans WHERE code=?1 AND demo=0"
  ).bind(data.plan_code).first<{ price_cents_month: number }>();
  if (!plan) return { status: "missing_plan" as const };

  // Uma mesma combinação e-mail/plano em 30 minutos vira apenas um registro.
  const bucket = Math.floor(time / 1_800_000);
  const result = await db.prepare(
    `INSERT INTO sales_leads
      (contact_name,company_name,email,phone,plan_code,price_snapshot_cents,message,consent_at,submission_bucket)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)
      ON CONFLICT(email,plan_code,submission_bucket) DO NOTHING`
  ).bind(data.contact_name,data.company_name,data.email,data.phone,data.plan_code,
    plan.price_cents_month,data.message,nowIso(new Date(time)),bucket).run();
  return result.meta?.changes === 1
    ? { status: "created" as const, id: Number(result.meta.last_row_id) }
    : { status: "duplicate" as const };
}

export async function listSalesLeads(db: D1Database, status = "", query = "") {
  const prefix = query ? `%${query}%` : "";
  const { results } = await db.prepare(
    `SELECT id,contact_name,company_name,email,phone,plan_code,price_snapshot_cents,
      message,status,internal_note,consent_at,created_at,updated_at
     FROM sales_leads
     WHERE (?1='' OR status=?1)
       AND (?2='' OR company_name LIKE ?3 OR contact_name LIKE ?3 OR email LIKE ?3)
     ORDER BY created_at DESC,id DESC LIMIT 150`
  ).bind(status,query,prefix).all<SalesLeadRow>();
  return results;
}

export async function updateSalesLead(db: D1Database, id: number, values: z.infer<typeof leadUpdateSchema>) {
  const result = await db.prepare(
    `UPDATE sales_leads SET status=?1,internal_note=?2,updated_at=?3 WHERE id=?4`
  ).bind(values.status,values.internal_note,nowIso(),id).run();
  return result.meta?.changes === 1;
}

/**
 * Ciclo de vida de dados comerciais. Default conservador de 180 dias,
 * alterável pelo Superadmin antes de abrir a contratação ao público.
 * A limpeza remove conteúdo pessoal do D1 e não copia contatos para auditoria.
 */
export const SALES_RETENTION_DAYS = [30, 90, 180, 365] as const;
export const salesRetentionSchema = z.object({
  days: z.union([z.literal(30), z.literal(90), z.literal(180), z.literal(365)]),
}).strict();

const retentionKey = "sales_leads_retention_days";

export async function getSalesRetentionDays(db: D1Database): Promise<number> {
  const saved = await db.prepare(
    "SELECT value FROM platform_settings WHERE key=?1"
  ).bind(retentionKey).first<{ value: string }>();
  const days = Number(saved?.value);
  return SALES_RETENTION_DAYS.some(x => x === days) ? days : 180;
}

export async function setSalesRetentionDays(db: D1Database, days: number): Promise<void> {
  if (!SALES_RETENTION_DAYS.some(x => x === days)) throw new Error("Prazo de retenção inválido");
  await db.prepare(
    "INSERT INTO platform_settings(key,value,updated_at) VALUES (?1,?2,?3) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at"
  ).bind(retentionKey, String(days), nowIso()).run();
}

/** Exclui no máximo 200 por rodada para não monopolizar o banco D1. */
export async function purgeExpiredSalesLeads(db: D1Database, now = Date.now()): Promise<number> {
  const days = await getSalesRetentionDays(db);
  const cutoff = nowIso(new Date(now - days * 86_400_000));
  const result = await db.prepare(
    "DELETE FROM sales_leads WHERE id IN (SELECT id FROM sales_leads WHERE created_at<?1 ORDER BY created_at ASC,id ASC LIMIT 200)"
  ).bind(cutoff).run();
  return Number(result.meta?.changes ?? 0);
}

/** Remove dados identificáveis de um contato, preservando somente o id na auditoria. */
export async function deleteSalesLead(db: D1Database, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM sales_leads WHERE id=?1").bind(id).run();
  return result.meta?.changes === 1;
}

/** Limpa fingerprints antigos; não são necessários após 48h. */
export async function purgeOldSalesRateLimits(db: D1Database, now = Date.now()): Promise<number> {
  const cutoff = Math.floor(now / 3_600_000) - 48;
  const result = await db.prepare("DELETE FROM sales_lead_rate_limits WHERE hour_bucket<?1")
    .bind(cutoff).run();
  return Number(result.meta?.changes ?? 0);
}
