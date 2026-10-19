import type { Env } from "../types";
import { nowIso } from "./utils";
import { mpProvider } from "./payments";
import { audit } from "./audit";
import { listPublicPlans } from "./plans";

export interface SubscriptionInvoice {
  id: number;
  company_id: number;
  code: string;
  plan_code: string;
  amount_cents: number;
  status: "creating" | "pending" | "paid" | "expired" | "failed";
  provider_payment_id: string | null;
  qr_code_text: string;
  qr_code_base64: string;
  expires_at: string | null;
  paid_at: string | null;
  created_at: string;
}

const pendingSql = "SELECT * FROM subscription_invoices WHERE company_id=?1 AND status IN ('creating','pending') ORDER BY id DESC LIMIT 1";

export async function billingSummary(db: D1Database, companyId: number) {
  const subscription = await db.prepare(
    `SELECT s.plan_code,s.status,s.period_end,s.started_at,p.name,p.price_cents_month
       FROM subscriptions s JOIN plans p ON p.code=s.plan_code WHERE s.company_id=?1`
  ).bind(companyId).first<{
    plan_code: string;status:string;period_end:string|null;started_at:string;name:string;price_cents_month:number
  }>();
  const invoice = await db.prepare(pendingSql).bind(companyId).first<SubscriptionInvoice>();
  return { subscription, invoice, plans: await listPublicPlans(db) };
}

export async function createSubscriptionPix(
  env: Env, companyId: number, payerEmail: string, selectedPlan: "free" | "pro" | "scale"
): Promise<{ ok: true; invoice: SubscriptionInvoice } | { ok: false; status: number; message: string }> {
  if (env.TIGU_STAGING === "1" || env.PAYMENTS_MOCK === "1")
    return { ok:false, status:503, message:"Pagamentos Pix reais desativados nesta homologação." };
  if (!env.MP_ACCESS_TOKEN || !env.MP_WEBHOOK_SECRET || !env.PUBLIC_URL?.startsWith("https://"))
    return { ok:false,status:503,message:"Mercado Pago não configurado com token, webhook e URL HTTPS." };
  const db=env.DB;
  const summary=await billingSummary(db,companyId);
  const sub=summary.subscription;
  if (!sub) return {ok:false,status:404,message:"Assinatura não encontrada."};
  const plan=summary.plans.find(p=>p.code===selectedPlan);
  if (!plan || !Number.isInteger(plan.price_cents_month) || plan.price_cents_month<=0)
    return {ok:false,status:422,message:"Plano ou preço mensal inválido."};
  const rank:Record<string,number>={free:0,pro:1,scale:2};
  // Upgrades são permitidos imediatamente; downgrades só depois do vencimento.
  if(sub.status==="active" && sub.period_end && sub.period_end>nowIso() &&
      rank[selectedPlan]<rank[sub.plan_code])
    return {ok:false,status:422,message:"A redução do plano poderá ser solicitada depois do vencimento atual."};
  if (summary.invoice) {
    // A hora de validade exibida não comprova que o pagamento não foi realizado.
    // Consultar o gateway ANTES de liberar a criação de outro QR Code.
    let pending=summary.invoice;
    if (pending.status==="pending" && pending.expires_at &&
        pending.expires_at<=nowIso() && pending.provider_payment_id) {
      const checked=await confirmSubscriptionPix(env,pending.provider_payment_id);
      if (!checked.ok) return {ok:false,status:409,
        message:"Não foi possível confirmar o Pix anterior no Mercado Pago. Verifique a fatura antes de solicitar outro."};
      if (checked.status==="paid") return {ok:false,status:409,
        message:"Pagamento anterior aprovado. Atualize a página para visualizar seu plano."};
      const revised=await db.prepare("SELECT * FROM subscription_invoices WHERE id=?1")
        .bind(pending.id).first<SubscriptionInvoice>();
      if (revised && ["expired","failed"].includes(revised.status)) pending=revised;
    }
    if (pending.status==="creating") return {ok:false,status:409,
      message:"O Mercado Pago ainda está preparando seu Pix. Não gere outra cobrança; aguarde ou contate o suporte."};
    if (pending.status==="pending") {
      if (pending.plan_code!==selectedPlan) return {ok:false,status:409,
        message:"Há um Pix aberto para outro plano. Verifique o pagamento antes de escolher outro."};
      return {ok:true,invoice:pending};
    }
    // Apenas status terminal confirmado pelo gateway libera nova fatura.
    if (!["expired","failed"].includes(pending.status))
      return {ok:false,status:409,message:"A cobrança anterior precisa ser conciliada."};
  }
  const code = "TIGU-SUB-" + crypto.randomUUID();
  const date=nowIso();
  // Índice único parcial garante que requisições simultâneas não criem dois Pix.
  try {
    await db.prepare(`INSERT INTO subscription_invoices
      (company_id,code,plan_code,amount_cents,status,created_at,updated_at)
      VALUES (?1,?2,?3,?4,'creating',?5,?5)`)
      .bind(companyId,code,selectedPlan,plan.price_cents_month,date).run();
  } catch {
    return {ok:false,status:409,message:"Já existe uma cobrança em criação. Atualize esta página."};
  }
  const inv=await db.prepare("SELECT * FROM subscription_invoices WHERE code=?1")
    .bind(code).first<SubscriptionInvoice>();
  if (!inv) return {ok:false,status:503,message:"Não foi possível gerar uma fatura."};
  // A chave idempotente é o próprio código da fatura, nunca um valor do cliente.
  let payment: Awaited<ReturnType<ReturnType<typeof mpProvider>["createPixPayment"]>>;
  try {
    payment=await mpProvider(env).createPixPayment({
      amountCents:plan.price_cents_month,externalReference:code,
      description:`Assinatura mensal Tigu ${plan.name}`,payerEmail
    });
  } catch {
    // Não criar segunda fatura: a resposta do Mercado Pago pode ter se perdido
    // depois de o pagamento ter sido criado. Exige conciliação assistida.
    return {ok:false,status:503,message:"Não foi possível confirmar a criação do Pix. Contate o suporte antes de tentar novamente."};
  }
  if (!payment.ok || !payment.qrCodeText || !payment.providerPaymentId) {
    await db.prepare("UPDATE subscription_invoices SET status='failed',updated_at=?2 WHERE id=?1 AND status='creating'")
      .bind(inv.id,nowIso()).run();
    return {ok:false,status:502,message:"Não foi possível gerar o código Pix. Tente novamente ou procure o suporte."};
  }
  const expires=payment.expiresAt || new Date(Date.now()+60*60_000).toISOString().replace(/\.\d{3}Z$/,"Z");
  await db.prepare(`UPDATE subscription_invoices SET
    status='pending',provider_payment_id=?1,qr_code_text=?2,qr_code_base64=?3,
    expires_at=?4,updated_at=?5 WHERE id=?6 AND status='creating'`)
    .bind(payment.providerPaymentId,payment.qrCodeText,payment.qrCodeBase64,expires,nowIso(),inv.id).run();
  return {ok:true,invoice:(await db.prepare("SELECT * FROM subscription_invoices WHERE id=?1")
    .bind(inv.id).first<SubscriptionInvoice>())!};
}

export async function confirmSubscriptionPix(env: Env, providerId: string): Promise<
  { ok:boolean; status:string; activated:boolean; message?:string }
> {
  if (env.TIGU_STAGING==="1" || !env.MP_ACCESS_TOKEN) return {ok:false,status:"blocked",activated:false};
  const db=env.DB;
  const inv=await db.prepare("SELECT * FROM subscription_invoices WHERE provider_payment_id=?1")
    .bind(providerId).first<SubscriptionInvoice>();
  if (!inv) return {ok:false,status:"not_found",activated:false};
  if (inv.status==="paid") return {ok:true,status:"paid",activated:false};
  if (!["pending","expired"].includes(inv.status)) return {ok:false,status:inv.status,activated:false};
  const payment=await mpProvider(env).getPaymentStatus(providerId);
  if (payment.status!=="approved") {
    if (["cancelled","rejected","expired"].includes(payment.status)) {
      await db.prepare("UPDATE subscription_invoices SET status=?1,updated_at=?2 WHERE id=?3 AND status='pending'")
        .bind(payment.status==="expired"?"expired":"failed",nowIso(),inv.id).run();
    }
    return {ok:true,status:payment.status,activated:false};
  }
  const detail=payment.detail || {};
  const amount=Number(detail.transaction_amount);
  if (String(detail.id??"")!==providerId || detail.external_reference!==inv.code ||
      detail.currency_id!=="BRL" || detail.payment_method_id!=="pix" ||
      !Number.isFinite(amount) || Math.round(amount*100)!==inv.amount_cents) {
    return {ok:false,status:"mismatch",activated:false,message:"Pix não corresponde à fatura original."};
  }
  const at=nowIso();
  // D1.batch é transacional: somente uma confirmação de uma fatura aberta
  // atualiza o período. Repetir Webhook/Poll jamais acrescenta outros meses.
  const changes=await db.batch([
    db.prepare(`UPDATE subscriptions SET status='active',plan_code=?3,
      period_end=strftime('%Y-%m-%dT%H:%M:%SZ',
        CASE WHEN period_end IS NOT NULL AND period_end>?1 THEN period_end ELSE ?1 END,
        '+1 month'),
      updated_at=?1 WHERE company_id=?2 AND EXISTS(
        SELECT 1 FROM subscription_invoices WHERE id=?4 AND company_id=?2
        AND plan_code=?3 AND status IN ('pending','expired'))`)
      .bind(at,inv.company_id,inv.plan_code,inv.id),
    db.prepare(`UPDATE subscription_invoices SET status='paid',paid_at=?1,updated_at=?1
      WHERE id=?2 AND status IN ('pending','expired')`)
      .bind(at,inv.id),
    db.prepare(`UPDATE companies SET plan_code=?1,updated_at=?2 WHERE id=?3
      AND EXISTS (SELECT 1 FROM subscription_invoices
        WHERE id=?4 AND status='paid' AND paid_at=?2)`)
      .bind(inv.plan_code,at,inv.company_id,inv.id),
  ]);
  const activated=changes.every(change=>change.meta.changes===1);
  if (!activated) return {ok:false,status:"conflict",activated:false};
  await audit(db,null,"subscription.pix_confirmed","subscription_invoice",inv.id,
    {plan_code:inv.plan_code,amount_cents:inv.amount_cents},{companyId:inv.company_id,scope:"platform"});
  return {ok:true,status:"paid",activated:true};
}

/** Reconsulta Pix ainda pendentes quando o webhook falhar. Não há automação no staging. */
export async function reconcileSubscriptionPix(env: Env, limit=20) {
  if (env.TIGU_STAGING==="1" || !env.MP_ACCESS_TOKEN) return {checked:0,activated:0};
  const {results}=await env.DB.prepare(`SELECT provider_payment_id FROM subscription_invoices
    WHERE status IN ('pending','expired') AND provider_payment_id IS NOT NULL
      AND created_at>=strftime('%Y-%m-%dT%H:%M:%SZ','now','-48 hours')
    ORDER BY updated_at ASC LIMIT ?1`).bind(Math.min(50,Math.max(1,limit)))
    .all<{provider_payment_id:string}>();
  let activated=0;
  for(const r of results){
    try {
      const result=await confirmSubscriptionPix(env,r.provider_payment_id);
      if(result.activated)activated++;
    } catch(e){console.error("[subscription-reconcile]",String(e).slice(0,100));}
  }
  return {checked:results.length,activated};
}
