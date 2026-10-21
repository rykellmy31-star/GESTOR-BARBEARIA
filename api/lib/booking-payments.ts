import type { Env } from "../types";
import { merchantFeatureEnabled, loadMerchant, createMerchantPayment, fetchMerchantPayment } from "./merchant-payments";
import { normalizePhone, nowIso } from "./utils";

export const bookingPixEnabled = merchantFeatureEnabled;

type PixStatus = "creating"|"pending"|"paid"|"expired"|"failed"|"refund_required"|"refunded";
interface PaymentRow {
  id: number; company_id: number; booking_id: number; code: string;
  amount_cents: number; status: PixStatus; provider_payment_id: string|null;
  qr_code_text: string; qr_code_base64: string;
  expires_at: string|null; paid_at: string|null;
}
export interface BookingPix {
  status: string; amount_cents: number; qr_code_text: string;
  qr_code_base64: string; expires_at: string|null; paid_at: string|null;
  message?: string;
}
function publicPayment(p:PaymentRow,message?:string): BookingPix {
  return {
    status:p.status,amount_cents:p.amount_cents,
    qr_code_text:p.status==="pending"?p.qr_code_text:"",
    qr_code_base64:p.status==="pending"?p.qr_code_base64:"",
    expires_at:p.expires_at,paid_at:p.paid_at,
    ...(message?{message}:{})
  };
}
function unavailable(message:string):BookingPix {
  return {status:"unavailable",amount_cents:0,qr_code_text:"",
    qr_code_base64:"",expires_at:null,paid_at:null,message};
}

export async function generateBookingPix(env:Env,companyId:number,bookingId:number):Promise<BookingPix> {
  const merchant=await loadMerchant(env,companyId);
  if(!merchant)
    return unavailable("A barbearia não habilitou pagamento online; a reserva permanece registrada.");
  const db=env.DB;
  const booking=await db.prepare("SELECT id,code,status,payment_choice,price_cents,customer_email FROM bookings WHERE id=?1 AND company_id=?2")
    .bind(bookingId,companyId).first<{id:number;code:string;status:string;payment_choice:string;price_cents:number;customer_email:string|null}>();
  if(!booking || booking.payment_choice!=="pix" || !["pendente","confirmado"].includes(booking.status))
    return unavailable("Agendamento não permite esta cobrança.");
  if(!booking.customer_email || !Number.isSafeInteger(booking.price_cents) || booking.price_cents<=0)
    return unavailable("Pix exige e-mail e preço válido do serviço.");
  const reference="TIGU-BOOK-"+crypto.randomUUID();
  const inserted=await db.prepare("INSERT OR IGNORE INTO booking_payments(company_id,booking_id,code,amount_cents) VALUES (?1,?2,?3,?4)")
    .bind(companyId,bookingId,reference,booking.price_cents).run();
  const current=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?1 AND company_id=?2")
    .bind(bookingId,companyId).first<PaymentRow>();
  if(!current)return unavailable("Falha ao criar cobrança de serviço.");
  // Idempotência: nunca emitir outro Pix em duplo clique ou retry de rede.
  if(inserted.meta.changes!==1)
    return publicPayment(current,current.status==="creating"?"Cobrança em preparação ou conciliação. Não pague duas vezes.":undefined);

  let result:Awaited<ReturnType<typeof createMerchantPayment>>;
  try {
    result=await createMerchantPayment(merchant,{
      amountCents:current.amount_cents,
      reference:current.code,
      description:"Serviço de barbearia - "+booking.code,
      payerEmail:booking.customer_email
    });
  } catch {
    return publicPayment(current,"Falha incerta do gateway. A cobrança deve ser conciliada antes de gerar outra.");
  }
  if(!result.ok) {
    if(result.uncertain)return publicPayment(current,"Resposta do gateway incerta. Não gerar cobrança duplicada.");
    await db.prepare("UPDATE booking_payments SET status='failed',updated_at=?2 WHERE id=?1 AND status='creating'")
      .bind(current.id,nowIso()).run();
    return {...publicPayment(current),status:"failed",
      message:"Não foi possível gerar Pix; combine o pagamento no atendimento com a barbearia."};
  }
  if(!result.providerPaymentId || !result.qrCodeText) {
    if(result.providerPaymentId)await db.prepare("UPDATE booking_payments SET provider_payment_id=?2,updated_at=?3 WHERE id=?1 AND status='creating'")
      .bind(current.id,result.providerPaymentId,nowIso()).run();
    return publicPayment(current,"Resposta incompleta do gateway. Solicite conciliação.");
  }
  const expires=result.expiresAt||new Date(Date.now()+3600000).toISOString().replace(/\.\d{3}Z$/,"Z");
  await db.prepare("UPDATE booking_payments SET status='pending',provider_payment_id=?2,qr_code_text=?3,qr_code_base64=?4,expires_at=?5,updated_at=?6 WHERE id=?1 AND status='creating'")
    .bind(current.id,result.providerPaymentId,result.qrCodeText,result.qrCodeBase64,expires,nowIso()).run();
  const updated=await db.prepare("SELECT * FROM booking_payments WHERE id=?1")
    .bind(current.id).first<PaymentRow>();
  return publicPayment(updated!);
}

export async function confirmBookingPix(env:Env,companyId:number,paymentId:string):Promise<{ok:boolean;status:string}> {
  const merchant=await loadMerchant(env,companyId);
  if(!merchant)return {ok:false,status:"disabled"};
  const db=env.DB;
  const inv=await db.prepare("SELECT p.*,b.status AS booking_status FROM booking_payments p JOIN bookings b ON b.id=p.booking_id AND b.company_id=p.company_id WHERE p.provider_payment_id=?1 AND p.company_id=?2")
    .bind(paymentId,companyId).first<PaymentRow&{booking_status:string}>();
  if(!inv)return {ok:false,status:"not_found"};
  if(["paid","refund_required","refunded"].includes(inv.status))return {ok:true,status:inv.status};
  if(!["pending","expired","failed"].includes(inv.status))return {ok:false,status:inv.status};
  const payment=await fetchMerchantPayment(merchant,paymentId);
  if(payment.status==="error"||payment.status==="not_found"||payment.status==="mismatch")return {ok:false,status:"gateway_unavailable"};
  if(payment.status==="approved") {
    const d=payment.detail||{};
    const amount=Number(d.transaction_amount);
    if(String(d.id??"")!==paymentId || d.external_reference!==inv.code ||
      d.currency_id!=="BRL" || d.payment_method_id!=="pix" ||
      !Number.isFinite(amount)||Math.round(amount*100)!==inv.amount_cents)
      return {ok:false,status:"mismatch"};
    const at=nowIso();
    // Verifica o cancelamento dentro do próprio UPDATE, não com snapshot antigo:
    // evita marcar "paid" caso cliente cancele no instante do webhook.
    await db.prepare("UPDATE booking_payments SET status=CASE WHEN EXISTS(SELECT 1 FROM bookings b WHERE b.id=booking_payments.booking_id AND b.company_id=booking_payments.company_id AND b.status='cancelado') THEN 'refund_required' ELSE 'paid' END,paid_at=?2,updated_at=?2 WHERE id=?1 AND status IN ('pending','expired','failed')")
      .bind(inv.id,at).run();
    const latest=await db.prepare("SELECT status FROM booking_payments WHERE id=?1").bind(inv.id).first<{status:string}>();
    return {ok:true,status:latest?.status??"pending"};
  }
  if(["cancelled","rejected","expired"].includes(payment.status)) {
    const status=payment.status==="expired"?"expired":"failed";
    await db.prepare("UPDATE booking_payments SET status=?2,updated_at=?3 WHERE id=?1 AND status='pending'")
      .bind(inv.id,status,nowIso()).run();
    return {ok:true,status};
  }
  return {ok:true,status:payment.status};
}

export async function lookupBookingPix(env:Env,companyId:number,code:string,phone:string,token:string):Promise<BookingPix|null> {
  if(!/^[A-Za-z0-9-]{4,32}$/.test(code)||!/^[a-f0-9-]{36}$/i.test(token))return null;
  const row=await env.DB.prepare("SELECT p.*,b.status AS booking_status FROM booking_payments p JOIN bookings b ON b.id=p.booking_id AND b.company_id=p.company_id WHERE b.company_id=?1 AND b.code=?2 AND b.customer_phone=?3 AND b.cancel_token=?4")
    .bind(companyId,code.toUpperCase(),normalizePhone(phone),token).first<PaymentRow>();
  if(!row)return null;
  if(row.provider_payment_id && row.status==="pending" && await loadMerchant(env,companyId)){
    await confirmBookingPix(env,companyId,row.provider_payment_id);
    const updated=await env.DB.prepare("SELECT * FROM booking_payments WHERE id=?1").bind(row.id).first<PaymentRow>();
    const latest=updated??row;
    if((row as PaymentRow&{booking_status:string}).booking_status==="cancelado" && latest.status==="pending")
      return {...publicPayment(latest),status:"cancelled",qr_code_text:"",qr_code_base64:"",
        message:"Reserva cancelada; não utilize o Pix gerado."};
    return publicPayment(latest);
  }
  if((row as PaymentRow&{booking_status:string}).booking_status==="cancelado" && row.status==="pending")
    return {...publicPayment(row),status:"cancelled",qr_code_text:"",qr_code_base64:"",
      message:"Reserva cancelada; não utilize o Pix gerado."};
  return publicPayment(row);
}
