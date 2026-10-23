import type { Env } from "../types";
import { encryptSecret, decryptSecret } from "./crypto";
import { nowIso } from "./utils";
import { mercadoPagoNotificationUrl } from "./payments";

interface Row {
 company_id:number;account_id:string;access_token_enc:string;webhook_secret_enc:string;
 webhook_key:string;enabled:number;
}
export function merchantFeatureEnabled(env:Env):boolean {
 return env.MERCHANT_PIX_ENABLED==="1" && env.TIGU_STAGING!=="1" &&
  env.APP_ENV==="production" && env.PAYMENTS_MOCK!=="1" &&
  Boolean(env.MSG_ENC_KEY && env.MSG_ENC_KEY.length>=32 && mercadoPagoNotificationUrl(env));
}
export function merchantNotificationUrl(env:Env,key:string):string|null {
 const url=mercadoPagoNotificationUrl(env);
 if(!url||!/^[0-9a-f-]{36}$/i.test(key))return null;
 const u=new URL(url);u.pathname="/api/webhooks/merchant-mercadopago/"+key;
 return u.toString();
}
export async function merchantStatus(env:Env,companyId:number) {
 const row=await env.DB.prepare("SELECT account_id,webhook_key,enabled FROM company_payment_integrations WHERE company_id=?1")
  .bind(companyId).first<Pick<Row,"account_id"|"webhook_key"|"enabled">>();
 return {connected:!!row,enabled:row?.enabled===1,account_id:row?.account_id??null,
  webhook_url:row?merchantNotificationUrl(env,row.webhook_key):null,
  pix_available:row?.enabled===1&&merchantFeatureEnabled(env)};
}
export async function merchantPixReady(env:Env,companyId:number):Promise<boolean> {
 if(!merchantFeatureEnabled(env))return false;
 const row=await env.DB.prepare("SELECT enabled FROM company_payment_integrations WHERE company_id=?1")
  .bind(companyId).first<{enabled:number}>();
 return row?.enabled===1;
}
export type Merchant=Row&{token:string;webhookSecret:string;notificationUrl:string};
export type PaymentRecipient=Pick<Merchant,"token"|"account_id"|"notificationUrl">;
export async function loadMerchant(env:Env,companyId:number):Promise<Merchant|null> {
 if(!merchantFeatureEnabled(env))return null;
 const row=await env.DB.prepare("SELECT * FROM company_payment_integrations WHERE company_id=?1 AND enabled=1")
  .bind(companyId).first<Row>();
 if(!row)return null;
 const [token,webhookSecret]=await Promise.all([
  decryptSecret(env,row.access_token_enc),decryptSecret(env,row.webhook_secret_enc)
 ]);
 const notificationUrl=merchantNotificationUrl(env,row.webhook_key);
 return token&&webhookSecret&&notificationUrl?{...row,token,webhookSecret,notificationUrl}:null;
}
export async function merchantByWebhookKey(env:Env,key:string):Promise<Merchant|null>{
 if(!merchantFeatureEnabled(env)||!/^[0-9a-f-]{36}$/i.test(key))return null;
 const r=await env.DB.prepare("SELECT company_id FROM company_payment_integrations WHERE webhook_key=?1 AND enabled=1")
  .bind(key).first<{company_id:number}>();
 return r?loadMerchant(env,r.company_id):null;
}
async function pendingCharges(env:Env,companyId:number):Promise<boolean> {
 const row=await env.DB.prepare(
  "SELECT (SELECT COUNT(*) FROM booking_payments WHERE company_id=?1 AND status IN ('creating','pending','refund_required')) + (SELECT COUNT(*) FROM order_payments WHERE company_id=?1 AND status IN ('creating','pending','refund_required')) AS n"
 ).bind(companyId).first<{n:number}>();
 return Number(row?.n??0)>0;
}
export type MerchantConfigResult={ok:true;account_id:string}|{ok:false;status:number;message:string};
export async function configureMerchant(env:Env,companyId:number,token:string,secret:string):Promise<MerchantConfigResult>{
 if(env.TIGU_STAGING==="1")return {ok:false,status:503,message:"Credenciais reais não podem ser configuradas em homologação."};
 if(!env.MSG_ENC_KEY||env.MSG_ENC_KEY.length<32)
  return {ok:false,status:503,message:"Criptografia não configurada no servidor."};
 if(!token||token.length<25||token.length>500||/[\s\x00-\x1f]/.test(token) ||
   !secret||secret.length<16||secret.length>500||/[\x00-\x1f]/.test(secret))
  return {ok:false,status:422,message:"Informe Access Token e chave do Webhook válidos."};
 if(await pendingCharges(env,companyId))
  return {ok:false,status:409,message:"Concilie pagamentos e estornos pendentes antes de trocar a conta."};
 let accountId="";
 try {
  const res=await fetch("https://api.mercadopago.com/users/me",{
   headers:{Authorization:"Bearer "+token},signal:AbortSignal.timeout(8000)
  });
  const data=await res.json().catch(()=>({})) as Record<string,unknown>;
  if(!res.ok||!Number.isSafeInteger(Number(data.id))||Number(data.id)<=0)
   return {ok:false,status:422,message:"O Mercado Pago não validou a conta informada."};
  accountId=String(data.id);
 }catch{
  return {ok:false,status:503,message:"Não foi possível validar a conta no Mercado Pago."};
 }
 const [tokenEnc,secretEnc]=await Promise.all([encryptSecret(env,token),encryptSecret(env,secret)]);
 const existing=await env.DB.prepare("SELECT webhook_key FROM company_payment_integrations WHERE company_id=?1")
  .bind(companyId).first<{webhook_key:string}>();
 const webhookKey=existing?.webhook_key??crypto.randomUUID();
 if(!merchantNotificationUrl(env,webhookKey))
  return {ok:false,status:503,message:"Configure PUBLIC_URL HTTPS antes de integrar pagamentos."};
 const sql="INSERT INTO company_payment_integrations(company_id,account_id,access_token_enc,webhook_secret_enc,webhook_key,enabled,updated_at)"+
  " VALUES (?1,?2,?3,?4,?5,1,?6) ON CONFLICT(company_id) DO UPDATE SET"+
  " account_id=excluded.account_id,access_token_enc=excluded.access_token_enc,"+
  " webhook_secret_enc=excluded.webhook_secret_enc,enabled=1,updated_at=excluded.updated_at";
 await env.DB.prepare(sql).bind(companyId,accountId,tokenEnc,secretEnc,webhookKey,nowIso()).run();
 return {ok:true,account_id:accountId};
}
export async function disconnectMerchant(env:Env,companyId:number):Promise<MerchantConfigResult>{
 if(await pendingCharges(env,companyId))
  return {ok:false,status:409,message:"Concilie pagamentos/estornos pendentes antes de desconectar."};
 await env.DB.prepare("DELETE FROM company_payment_integrations WHERE company_id=?1").bind(companyId).run();
 return {ok:true,account_id:""};
}
export interface MerchantPaymentResponse {
 ok:boolean;error?:string;uncertain?:boolean;providerPaymentId?:string;
 qrCodeText?:string;qrCodeBase64?:string;expiresAt?:string|null;
}
export async function createMerchantPayment(m:PaymentRecipient,p:{
 amountCents:number;reference:string;description:string;payerEmail:string
}):Promise<MerchantPaymentResponse> {
 if(!Number.isSafeInteger(p.amountCents)||p.amountCents<=0||!p.payerEmail)
  return {ok:false,error:"Dados inválidos"};
 try {
  const res=await fetch("https://api.mercadopago.com/v1/payments",{
   method:"POST",headers:{"Authorization":"Bearer "+m.token,"Content-Type":"application/json",
    "X-Idempotency-Key":p.reference},
   body:JSON.stringify({transaction_amount:p.amountCents/100,description:p.description,
    payment_method_id:"pix",external_reference:p.reference,
    notification_url:m.notificationUrl,expiration_date_interval:"01:00:00",
    payer:{email:p.payerEmail}}),signal:AbortSignal.timeout(10000)
  });
  const d=await res.json().catch(()=>({})) as Record<string,unknown>;
  if(!res.ok || !(typeof d.id==="string"||typeof d.id==="number"))
   return {ok:false,error:"Mercado Pago recusou a geração do Pix."};
  if(d.collector_id!=null&&String(d.collector_id)!==m.account_id)
   return {ok:false,uncertain:true,error:"Conta recebedora divergente."};
  const point=d.point_of_interaction as {transaction_data?:{qr_code?:string;qr_code_base64?:string}}|undefined;
  return {ok:true,providerPaymentId:String(d.id),
   qrCodeText:point?.transaction_data?.qr_code||"",
   qrCodeBase64:point?.transaction_data?.qr_code_base64||"",
   expiresAt:typeof d.date_of_expiration==="string"?d.date_of_expiration:null};
 }catch{return {ok:false,uncertain:true,error:"Resposta incerta do Mercado Pago."};}
}
export async function fetchMerchantPayment(m:PaymentRecipient,paymentId:string):
 Promise<{status:string;detail?:Record<string,unknown>}> {
 try {
  const res=await fetch("https://api.mercadopago.com/v1/payments/"+encodeURIComponent(paymentId),{
   headers:{Authorization:"Bearer "+m.token},signal:AbortSignal.timeout(8000)
  });
  if(!res.ok)return {status:"error"};
  const detail=await res.json().catch(()=>({})) as Record<string,unknown>;
  if(detail.collector_id!=null&&String(detail.collector_id)!==m.account_id)
   return {status:"mismatch"};
  return {status:typeof detail.status==="string"?detail.status:"error",detail};
 }catch{return {status:"error"};}
}
