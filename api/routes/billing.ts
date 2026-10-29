import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { tenantMiddleware, cid } from "../lib/tenant";
import { err, json } from "../lib/utils";
import { billingSummary, createSubscriptionPix, confirmSubscriptionPix } from "../lib/subscription-billing";
import { platformBillingMode } from "../lib/platform-billing-mode";
import { audit } from "../lib/audit";

export const billingRouter=new Hono<{Bindings:Env}>();
billingRouter.use("*",tenantMiddleware({auth:"admin"}));

function owner(c: {get:(key:"company")=>any}): boolean {
  return c.get("company")?.role==="owner";
}

billingRouter.get("/status",async c=>{
  if(!owner(c)) return err(c,"Somente o proprietário pode consultar a assinatura.",403);
  const result=await billingSummary(c.env.DB,cid(c));
  const mode=platformBillingMode(c.env);
  const plan_request=mode==="manual"?await c.env.DB.prepare("SELECT id,plan_code,created_at FROM subscription_plan_requests WHERE company_id=?1 AND status='pending'").bind(cid(c)).first():null;
  c.header("Cache-Control","no-store");
  return json(c,{ ...result, plan_request, billing_mode: mode });
});

// Proprietário apenas SOLICITA um plano; nunca ativa o próprio acesso.
billingRouter.post("/plan-request",async c=>{
  if(!owner(c)) return err(c,"Somente o proprietário pode solicitar um plano.",403);
  if(platformBillingMode(c.env)!=="manual") return err(c,"Solicitação manual indisponível.",409);
  const parsed=z.object({plan_code:z.enum(["free","pro","scale"])}).strict()
    .safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success) return err(c,"Selecione um plano válido.",422);
  const companyId=cid(c),db=c.env.DB;
  const existing=await db.prepare("SELECT id,plan_code FROM subscription_plan_requests WHERE company_id=?1 AND status='pending'")
    .bind(companyId).first<{id:number;plan_code:string}>();
  if(existing){
    if(existing.plan_code!==parsed.data.plan_code) return err(c,"Já existe uma solicitação pendente de outro plano. Contate o suporte.",409);
    return json(c,{ok:true,request_id:existing.id,status:"pending",already_pending:true});
  }
  const found=await db.prepare("SELECT code FROM plans WHERE code=?1 AND demo=0").bind(parsed.data.plan_code).first();
  if(!found) return err(c,"Plano não disponível.",422);
  try {
    await db.prepare("INSERT OR IGNORE INTO subscription_plan_requests(company_id,plan_code) VALUES (?1,?2)")
      .bind(companyId,parsed.data.plan_code).run();
  } catch {return err(c,"Não foi possível registrar a solicitação.",503);}
  const req=await db.prepare("SELECT id,plan_code FROM subscription_plan_requests WHERE company_id=?1 AND status='pending'")
    .bind(companyId).first<{id:number;plan_code:string}>();
  if(!req||req.plan_code!==parsed.data.plan_code) return err(c,"Há uma solicitação pendente diferente.",409);
  await audit(db,c.get("user"),"subscription.plan_requested","subscription_plan_request",req.id,{plan_code:req.plan_code},{companyId,scope:"platform"});
  return json(c,{ok:true,request_id:req.id,status:"pending"});
});

billingRouter.post("/pix",async c=>{
  if(platformBillingMode(c.env)==="manual") return err(c,"Mensalidades são cobradas fora da plataforma. Solicite seu plano ao responsável.",409);
  if(!owner(c)) return err(c,"Apenas o proprietário pode contratar o plano.",403);
  const parsed=z.object({plan_code:z.enum(["free","pro","scale"])}).strict()
    .safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success) return err(c,"Selecione Start, Pro ou Scale para gerar o Pix.",422);
  const result=await createSubscriptionPix(c.env,cid(c),c.get("user").email,parsed.data.plan_code);
  if(!result.ok) return err(c,result.message,result.status as 409|422|502|503);
  return json(c,{invoice:result.invoice});
});

billingRouter.post("/pix/verify",async c=>{
  if(!owner(c)) return err(c,"Somente o proprietário pode verificar pagamentos.",403);
  const parsed=z.object({invoice_id:z.number().int().positive()}).strict()
    .safeParse(await c.req.json().catch(()=>null));
  if(!parsed.success) return err(c,"Fatura inválida.",422);
  const invoice=await c.env.DB.prepare(
    "SELECT id,provider_payment_id,status FROM subscription_invoices WHERE id=?1 AND company_id=?2"
  ).bind(parsed.data.invoice_id,cid(c)).first<{id:number;provider_payment_id:string|null;status:string}>();
  if(!invoice) return err(c,"Fatura não encontrada.",404);
  if(invoice.status==="paid") return json(c,{ok:true,status:"paid",activated:false});
  if(!invoice.provider_payment_id) return err(c,"Pix ainda não disponível.",409);
  const result=await confirmSubscriptionPix(c.env,invoice.provider_payment_id);
  if(!result.ok) return err(c,result.message || "Ainda não foi possível confirmar o pagamento.",409);
  return json(c,result);
});
