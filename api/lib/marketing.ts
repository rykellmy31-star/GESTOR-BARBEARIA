import { z } from "zod";

/** Contato comercial da plataforma Tigu, independente dos dados de cada barbearia. */
const salesKeys = {
  enabled: "sales_contact_enabled",
  whatsapp: "sales_contact_whatsapp",
  email: "sales_contact_email",
  title: "sales_contact_title",
  message: "sales_contact_message",
} as const;

export const defaultSalesContact = {
  enabled: false,
  whatsapp: "",
  email: "",
  title: "Ficou alguma dúvida antes de contratar?",
  message: "Olá! Conheci o Tigu e gostaria de tirar algumas dúvidas sobre os planos.",
};

export const salesContactSchema = z.object({
  enabled: z.boolean(),
  whatsapp: z.string().trim().max(32).transform((v) => v.replace(/[^0-9]/g, ""))
    .refine((v) => !v || /^[1-9][0-9]{9,14}$/.test(v), "Informe DDI + DDD + número, com 10 a 15 dígitos."),
  email: z.union([z.literal(""), z.string().trim().email("E-mail inválido").max(120)]),
  title: z.string().trim().min(10).max(110),
  message: z.string().trim().min(8).max(250),
}).strict().refine(
  (v) => !v.enabled || Boolean(v.whatsapp || v.email),
  { message: "Cadastre WhatsApp ou e-mail para ativar o contato.", path: ["enabled"] }
);

export type SalesContact = z.infer<typeof salesContactSchema>;

export async function loadSalesContact(db: D1Database): Promise<SalesContact> {
  const { results } = await db.prepare(
    "SELECT key,value FROM platform_settings WHERE key IN (?1,?2,?3,?4,?5)"
  ).bind(
    salesKeys.enabled, salesKeys.whatsapp, salesKeys.email, salesKeys.title, salesKeys.message
  ).all<{ key: string; value: string }>();

  const entries = new Map(results.map((r) => [r.key, r.value]));
  const data = {
    enabled: entries.get(salesKeys.enabled) === "1",
    whatsapp: entries.get(salesKeys.whatsapp) ?? defaultSalesContact.whatsapp,
    email: entries.get(salesKeys.email) ?? defaultSalesContact.email,
    title: entries.get(salesKeys.title) ?? defaultSalesContact.title,
    message: entries.get(salesKeys.message) ?? defaultSalesContact.message,
  };
  const parsed = salesContactSchema.safeParse(data);
  return parsed.success ? parsed.data : { ...defaultSalesContact };
}

export async function saveSalesContact(db: D1Database, values: SalesContact): Promise<void> {
  const entries = [
    [salesKeys.enabled, values.enabled ? "1" : "0"],
    [salesKeys.whatsapp, values.whatsapp],
    [salesKeys.email, values.email],
    [salesKeys.title, values.title],
    [salesKeys.message, values.message],
  ];
  const sql = "INSERT INTO platform_settings (key,value,updated_at) VALUES (?1,?2,strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at";
  await db.batch(entries.map(([key, value]) => db.prepare(sql).bind(key, value)));
}

/** A página pública só recebe os contatos quando o proprietário os publica. */
export function publicSalesContact(contact: SalesContact): SalesContact {
  return contact.enabled ? contact : { ...defaultSalesContact };
}
