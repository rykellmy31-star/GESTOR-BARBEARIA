import { describe, expect, it } from "vitest";
import { platformBillingMode } from "./platform-billing-mode";
import { isSubscriptionBillingAction, requiresSubscriptionToWrite } from "./trial";

describe("Mensalidade manual isolada do TIGU",()=>{
  it("usa cobrança externa como padrão, sem Mercado Pago da plataforma",()=>{
    expect(platformBillingMode({})).toBe("manual");
    expect(platformBillingMode({TIGU_PLATFORM_BILLING_MODE:"manual"})).toBe("manual");
    expect(platformBillingMode({TIGU_PLATFORM_BILLING_MODE:"mercadopago"})).toBe("mercadopago");
  });
  it("permite solicitar plano com assinatura vencida, sem liberar escrita operacional",()=>{
    const req="/api/c/barbearia-teste/billing/plan-request";
    expect(isSubscriptionBillingAction("POST",req)).toBe(true);
    expect(requiresSubscriptionToWrite("POST",req,true)).toBe(false);
    expect(requiresSubscriptionToWrite("POST","/api/c/barbearia-teste/admin/services",true)).toBe(true);
    expect(isSubscriptionBillingAction("GET",req)).toBe(false);
  });
  it("preserva as rotas antigas de conciliação de faturas já geradas",()=>{
    expect(isSubscriptionBillingAction("POST","/api/c/barbearia-teste/billing/pix/verify")).toBe(true);
  });
});
