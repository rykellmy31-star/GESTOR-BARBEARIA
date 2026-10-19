import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { tenantMiddleware, cid } from "../lib/tenant";
import { err, json } from "../lib/utils";
import { billingSummary, createSubscriptionPix, confirmSubscriptionPix } from "../lib/subscription-billing";

export const billingRouter=new Hono<{Bindings:Env}>();
billingRouter.use("*",tenantMiddleware({auth:"admin"}));

function owner(c: {get:(key:"company")=>any}): boolean {
  return c.get("company")?.role==="owner";
}

billingRouter.get("/status",async c=>{
  if(!owner(c)) return err(c,"Somente o proprietário pode consultar a assinatura.",403);
  const result=await billingSummary(c.env.DB,cid(c));
  return json(c,result);
});

billingRouter.post("/pix",async c=>{
  if(!owner(c)) return err(c,"Apenas o proprietário pode contratar o plano.",403);
  const result=await createSubscriptionPix(c.env,cid(c),c.get("user").email);
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
