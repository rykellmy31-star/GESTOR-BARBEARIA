import type {Env} from "../types";
import {createMerchantPayment,fetchMerchantPayment,loadMerchant} from "./merchant-payments";
import {nowIso,normalizePhone} from "./utils";

interface OrderPayment {
 id:number;company_id:number;order_id:number;code:string;lookup_token:string;
 amount_cents:number;status:string;provider_payment_id:string|null;
 qr_code_text:string;qr_code_base64:string;expires_at:string|null;paid_at:string|null;
}
export interface PublicOrderPayment {
 status:string;amount_cents:number;qr_code_text:string;qr_code_base64:string;
 expires_at:string|null;paid_at:string|null;message?:string;
}
function view(p:OrderPayment,message?:string):PublicOrderPayment {
 return {status:p.status,amount_cents:p.amount_cents,
  qr_code_text:p.status==="pending"?p.qr_code_text:"",
  qr_code_base64:p.status==="pending"?p.qr_code_base64:"",
  expires_at:p.expires_at,paid_at:p.paid_at,...(message?{message}:{})};
}
function unavailable(message:string):PublicOrderPayment {
 return {status:"unavailable",amount_cents:0,qr_code_text:"",qr_code_base64:"",
  expires_at:null,paid_at:null,message};
}
export async function generateOrderPix(env:Env,companyId:number,orderId:number):Promise<{
 payment:PublicOrderPayment;lookup_token:string|null
}> {
 const m=await loadMerchant(env,companyId);
 if(!m)return {payment:unavailable("Barbearia sem Pix ativo. Pedido registrado para pagamento combinado."),lookup_token:null};
 const db=env.DB;
 const order=await db.prepare("SELECT id,code,status,payment_choice,total_cents,customer_email FROM orders WHERE id=?1 AND company_id=?2")
  .bind(orderId,companyId).first<{id:number;code:string;status:string;payment_choice:string;total_cents:number;customer_email:string|null}>();
 if(!order||order.payment_choice!=="pix"||order.status!=="novo"||!order.customer_email||order.total_cents<=0)
  return {payment:unavailable("Pedido não permite Pix."),lookup_token:null};
 const reference="TIGU-ORDER-"+crypto.randomUUID(),access=crypto.randomUUID();
 const ins=await db.prepare("INSERT OR IGNORE INTO order_payments(company_id,order_id,code,lookup_token,amount_cents) VALUES (?1,?2,?3,?4,?5)")
  .bind(companyId,orderId,reference,access,order.total_cents).run();
 const row=await db.prepare("SELECT * FROM order_payments WHERE order_id=?1 AND company_id=?2")
  .bind(orderId,companyId).first<OrderPayment>();
 if(!row)return {payment:unavailable("Não foi possível gerar cobrança."),lookup_token:null};
 if(ins.meta.changes!==1)return {lookup_token:row.lookup_token,
  payment:view(row,row.status==="creating"?"Pix em preparação ou conciliação. Não gere outro pagamento.":undefined)};
 const p=await createMerchantPayment(m,{amountCents:row.amount_cents,reference:row.code,
  description:"Produtos barbearia - "+order.code,payerEmail:order.customer_email});
 if(!p.ok){
  if(!p.uncertain)await db.prepare("UPDATE order_payments SET status='failed',updated_at=?2 WHERE id=?1 AND status='creating'")
   .bind(row.id,nowIso()).run();
  return {lookup_token:row.lookup_token,
   payment:{...view(row),status:p.uncertain?"creating":"failed",
    message:p.uncertain?"O gateway não confirmou a emissão. Não pague duas vezes.":"Pix indisponível. Combine o pagamento com a barbearia."}};
 }
 if(!p.providerPaymentId||!p.qrCodeText){
  if(p.providerPaymentId)await db.prepare("UPDATE order_payments SET provider_payment_id=?2,updated_at=?3 WHERE id=?1 AND status='creating'")
   .bind(row.id,p.providerPaymentId,nowIso()).run();
  return {lookup_token:row.lookup_token,payment:view(row,"Pix incompleto. Solicite conciliação.")};
 }
 const exp=p.expiresAt||new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/,"Z");
 await db.prepare("UPDATE order_payments SET status='pending',provider_payment_id=?2,qr_code_text=?3,qr_code_base64=?4,expires_at=?5,updated_at=?6 WHERE id=?1 AND status='creating'")
  .bind(row.id,p.providerPaymentId,p.qrCodeText,p.qrCodeBase64,exp,nowIso()).run();
 const fresh=await db.prepare("SELECT * FROM order_payments WHERE id=?1").bind(row.id).first<OrderPayment>();
 return {lookup_token:row.lookup_token,payment:view(fresh!)};
}
export async function confirmOrderPix(env:Env,companyId:number,id:string):Promise<{ok:boolean;status:string}> {
 const m=await loadMerchant(env,companyId);
 if(!m)return {ok:false,status:"disabled"};
 const db=env.DB;
 const p=await db.prepare("SELECT * FROM order_payments WHERE provider_payment_id=?1 AND company_id=?2")
  .bind(id,companyId).first<OrderPayment>();
 if(!p)return {ok:false,status:"not_found"};
 if(["paid","refund_required","refunded"].includes(p.status))return {ok:true,status:p.status};
 if(!["pending","failed","expired"].includes(p.status))return {ok:false,status:p.status};
 const payment=await fetchMerchantPayment(m,id);
 if(["error","not_found","mismatch"].includes(payment.status))return {ok:false,status:"gateway_unavailable"};
 if(payment.status==="approved"){
  const d=payment.detail||{},amt=Number(d.transaction_amount);
  if(String(d.id??"")!==id||d.external_reference!==p.code||d.currency_id!=="BRL"||
     d.payment_method_id!=="pix"||!Number.isFinite(amt)||Math.round(amt*100)!==p.amount_cents)
   return {ok:false,status:"mismatch"};
  const at=nowIso();
  await db.batch([
   db.prepare("UPDATE order_payments SET status=CASE WHEN EXISTS(SELECT 1 FROM orders o WHERE o.id=order_payments.order_id AND o.company_id=order_payments.company_id AND o.status='cancelado') THEN 'refund_required' ELSE 'paid' END,paid_at=?2,updated_at=?2 WHERE id=?1 AND status IN ('pending','failed','expired')")
    .bind(p.id,at),
   db.prepare("UPDATE orders SET status='pago',paid_at=?3,updated_at=?3 WHERE id=?1 AND company_id=?2 AND status='novo' AND EXISTS(SELECT 1 FROM order_payments p WHERE p.order_id=orders.id AND p.company_id=orders.company_id AND p.status='paid')")
    .bind(p.order_id,companyId,at),
  ]);
  const updated=await db.prepare("SELECT status FROM order_payments WHERE id=?1").bind(p.id).first<{status:string}>();
  return {ok:true,status:updated?.status||"pending"};
 }
 if(["cancelled","rejected","expired"].includes(payment.status)){
  const status=payment.status==="expired"?"expired":"failed";
  await db.prepare("UPDATE order_payments SET status=?2,updated_at=?3 WHERE id=?1 AND status='pending'")
   .bind(p.id,status,nowIso()).run();
  return {ok:true,status};
 }
 return {ok:true,status:payment.status};
}
export async function lookupOrderPix(env:Env,companyId:number,code:string,phone:string,token:string):Promise<PublicOrderPayment|null>{
 if(!/^[A-Za-z0-9-]{4,32}$/.test(code)||!/^[0-9a-f-]{36}$/i.test(token))return null;
 const row=await env.DB.prepare("SELECT p.*,o.status AS order_status FROM order_payments p JOIN orders o ON o.id=p.order_id AND o.company_id=p.company_id WHERE o.company_id=?1 AND o.code=?2 AND o.customer_phone=?3 AND p.lookup_token=?4")
  .bind(companyId,code.toUpperCase(),normalizePhone(phone),token).first<OrderPayment&{order_status:string}>();
 if(!row)return null;
 let latest:OrderPayment=row;
 if(row.provider_payment_id&&row.status==="pending"&&await loadMerchant(env,companyId)){
  await confirmOrderPix(env,companyId,row.provider_payment_id);
  latest=(await env.DB.prepare("SELECT * FROM order_payments WHERE id=?1").bind(row.id).first<OrderPayment>())??row;
 }
 if(row.order_status==="cancelado"&&latest.status==="pending")
  return {...view(latest),status:"cancelled",qr_code_text:"",qr_code_base64:"",message:"Pedido cancelado; não utilize o Pix."};
 return view(latest);
}
