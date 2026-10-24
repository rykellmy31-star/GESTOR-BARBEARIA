/** Regras de acesso de testes e assinaturas confirmadas; este módulo não gera cobranças. */
export const START_TRIAL_DAYS = 15;

export interface SubscriptionAccess {
  status: "trial" | "active" | "past_due" | "cancelled";
  period_end: string | null;
  plan_code: string;
}

export async function subscriptionAccess(db: D1Database, companyId: number): Promise<SubscriptionAccess | null> {
  return db.prepare(
    "SELECT status,period_end,plan_code FROM subscriptions WHERE company_id=?1"
  ).bind(companyId).first<SubscriptionAccess>();
}

/** O encerramento é exclusivo: expirou na data/hora exata registrada no D1. */
export function canOperateSubscription(sub: SubscriptionAccess | null, now: Date = new Date()): boolean {
  if (!sub) return false;
  if (sub.status === "active") {
    // Renovação mensal exige período válido: nunca liberar indefinidamente.
    return Boolean(sub.period_end && new Date(sub.period_end).getTime() > now.getTime());
  }
  if (sub.status !== "trial" || !sub.period_end) return false;
  return new Date(sub.period_end).getTime() > now.getTime();
}

export function isTrialExpired(sub: SubscriptionAccess | null, now: Date = new Date()): boolean {
  return Boolean(sub?.status === "trial" && !canOperateSubscription(sub, now));
}

/** Somente bloqueia criação de novas reservas/pedidos, não cancelamentos existentes. */
export function requiresSubscriptionToWrite(method: string, route: string, authenticatedArea: boolean): boolean {
  if (!["POST","PUT","PATCH","DELETE"].includes(method)) return false;
  // Pagamento de renovação precisa permanecer possível mesmo após 15 dias.
  if (/^\/api\/c\/[a-z0-9-]+\/billing\/pix(?:\/verify)?$/.test(route)) return false;
  if (authenticatedArea) return true;
  return /^\/api\/c\/[a-z0-9-]+\/(?:bookings|orders)$/.test(route) && method === "POST";
}

/** Cobrança e verificação de Pix continuam acessíveis após o teste expirar. */
export function isSubscriptionBillingAction(method: string, path: string): boolean {
  return method === "POST" &&
    /^\/api\/c\/[a-z0-9-]+\/billing\/pix(?:\/verify)?$/.test(path);
}
