import type { Env } from "../types";

/**
 * Mensalidade da PLATAFORMA TIGU; não altera Pix de serviços dos profissionais,
 * recebimentos das barbearias, recargas da carteira ou WhatsApp da Meta.
 */
export function platformBillingMode(env: Pick<Env, "TIGU_PLATFORM_BILLING_MODE">): "manual" | "mercadopago" {
  return env.TIGU_PLATFORM_BILLING_MODE === "mercadopago" ? "mercadopago" : "manual";
}
