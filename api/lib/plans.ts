import { z } from "zod";

export const planCodes = ["free", "pro", "scale"] as const;
export const planCodeSchema = z.enum(planCodes);

export const planEditSchema = z.object({
  name: z.string().trim().min(4).max(60),
  price_cents_month: z.number().int().min(0).max(1_000_000),
  max_barbers: z.number().int().min(-1).max(500).refine(n => n !== 0, "Informe ao menos um barbeiro ou -1."),
  // Compatibilidade com formulários em cache. As duas opções legadas são
  // ignoradas: todos os planos possuem Evolution com envios ilimitados.
  max_messages_month: z.number().int().min(-1).max(1_000_000).optional(),
  whatsapp_enabled: z.boolean().optional(),
  store_enabled: z.boolean(),
}).strict();

export interface PlanRow {
  code: typeof planCodes[number];
  name: string;
  price_cents_month: number;
  max_barbers: number;
  max_messages_month: number;
  whatsapp_enabled: number;
  store_enabled: number;
}

export async function listPublicPlans(db: D1Database): Promise<PlanRow[]> {
  const { results } = await db.prepare(
    "SELECT code,name,price_cents_month,max_barbers,max_messages_month,whatsapp_enabled,store_enabled FROM plans WHERE code IN ('free','pro','scale') AND demo=0 ORDER BY CASE code WHEN 'free' THEN 0 WHEN 'pro' THEN 1 ELSE 2 END"
  ).all<PlanRow>();
  // O D1 mantém valores históricos. A API publica as regras reais em vigor
  // sem depender de migração destrutiva ou editar assinaturas existentes.
  return results.map(plan => ({ ...plan, max_messages_month: -1, whatsapp_enabled: 1 }));
}

/** Uma alteração de preço não inicia cobranças: recorrência exige gateway próprio. */
export async function changePlan(db: D1Database, code: PlanRow["code"], value: z.infer<typeof planEditSchema>) {
  return db.prepare(
    "UPDATE plans SET name=?1,price_cents_month=?2,max_barbers=?3,max_messages_month=?4,whatsapp_enabled=?5,store_enabled=?6,updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE code=?7 AND demo=0"
  ).bind(value.name,value.price_cents_month,value.max_barbers,-1,
    1,value.store_enabled ? 1 : 0,code).run();
}
