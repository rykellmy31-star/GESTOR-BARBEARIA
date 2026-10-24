// Pix do profissional: usa exclusivamente o OAuth do próprio barbeiro.
// Nunca usa MP_ACCESS_TOKEN (assinaturas/carteira da plataforma).
import type { Env } from "../types";
import { decryptSecret, encryptSecret } from "./crypto";
import { mercadoPagoNotificationUrl } from "./payments";
import type { PaymentRecipient } from "./merchant-payments";

type SellerRow={company_id:number;barber_id:number;mp_user_id:string;access_ciphertext:string;
 refresh_ciphertext:string;expires_at:string};
const mpId=(x:unknown)=>typeof x==="number"&&Number.isSafeInteger(x)&&x>0?String(x):
 typeof x==="string"&&/^\d{1,20}$/.test(x)?x:"";

export function sellerPaymentsEnabled(env:Env):boolean{
 return env.MERCHANT_PIX_ENABLED==="1"&&env.TIGU_STAGING!=="1"&&
  env.APP_ENV==="production"&&env.PAYMENTS_MOCK!=="1"&&
  Boolean(env.MSG_ENC_KEY&&env.MSG_ENC_KEY.length>=32&&
   env.MP_MARKETPLACE_CLIENT_ID&&env.MP_MARKETPLACE_CLIENT_SECRET&&
   env.MP_MARKETPLACE_WEBHOOK_SECRET&&env.MP_MARKETPLACE_WEBHOOK_SECRET.length>=16&&
   mercadoPagoNotificationUrl(env));
}

export function sellerNotificationUrl(env:Env,companyId:number,barberId:number):string|null{
 if(!sellerPaymentsEnabled(env)||!Number.isSafeInteger(companyId)||companyId<=0||
    !Number.isSafeInteger(barberId)||barberId<=0)return null;
 const u=new URL(mercadoPagoNotificationUrl(env)!);
 u.pathname="/api/webhooks/seller-mercadopago/"+companyId+"/"+barberId;
 return u.toString();
}

export async function sellerPixReady(env:Env,companyId:number,barberId:number):Promise<boolean>{
 if(!sellerPaymentsEnabled(env)||!Number.isSafeInteger(barberId)||barberId<=0)return false;
 const row=await env.DB.prepare(`SELECT 1 AS ok FROM seller_mp_accounts a
  JOIN barbers b ON b.id=a.barber_id AND b.company_id=a.company_id AND b.active=1
  JOIN companies c ON c.id=a.company_id AND c.demo=0
  WHERE a.company_id=?1 AND a.barber_id=?2 AND a.mp_user_id<>''`)
  .bind(companyId,barberId).first();
 return Boolean(row);
}

// A renovação segura é condicional ao refresh token ainda vigente no banco.
// Disputas concorrentes não sobrescrevem credenciais de outra conta.
async function refreshSeller(env:Env,row:SellerRow):Promise<SellerRow|null>{
 const refresh=await decryptSecret(env,row.refresh_ciphertext);
 if(!refresh)return null;
 try{
  const res=await fetch("https://api.mercadopago.com/oauth/token",{
   method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},
   body:JSON.stringify({grant_type:"refresh_token",client_id:env.MP_MARKETPLACE_CLIENT_ID,
    client_secret:env.MP_MARKETPLACE_CLIENT_SECRET,refresh_token:refresh}),
   signal:AbortSignal.timeout(10000)
  });
  if(!res.ok)return null;
  const t=await res.json() as Record<string,unknown>;
  if(mpId(t.user_id)!==row.mp_user_id||typeof t.access_token!=="string"||
     typeof t.refresh_token!=="string"||t.access_token.length<8||
     t.refresh_token.length<8||t.access_token.length>8192||
     t.refresh_token.length>8192||typeof t.expires_in!=="number"||
     !Number.isSafeInteger(t.expires_in)||t.expires_in<60||t.expires_in>31536000)
   return null;
  const [access,renewed]=await Promise.all([
   encryptSecret(env,t.access_token),encryptSecret(env,t.refresh_token)]);
  const expires=new Date(Date.now()+t.expires_in*1000).toISOString();
  const result=await env.DB.prepare(`UPDATE seller_mp_accounts
    SET access_ciphertext=?1,refresh_ciphertext=?2,expires_at=?3,updated_at=?4
    WHERE company_id=?5 AND barber_id=?6 AND mp_user_id=?7 AND refresh_ciphertext=?8`)
   .bind(access,renewed,expires,new Date().toISOString(),row.company_id,
    row.barber_id,row.mp_user_id,row.refresh_ciphertext).run();
  if(result.meta.changes===1)return {...row,access_ciphertext:access,
   refresh_ciphertext:renewed,expires_at:expires};
  const latest=await env.DB.prepare(`SELECT * FROM seller_mp_accounts
    WHERE company_id=?1 AND barber_id=?2 AND mp_user_id=?3`)
   .bind(row.company_id,row.barber_id,row.mp_user_id).first<SellerRow>();
  return latest&&Date.parse(latest.expires_at)>Date.now()+30000?latest:null;
 }catch{return null;}
}

export async function loadSeller(env:Env,companyId:number,barberId:number):Promise<PaymentRecipient|null>{
 if(!await sellerPixReady(env,companyId,barberId))return null;
 let row=await env.DB.prepare(`SELECT * FROM seller_mp_accounts
  WHERE company_id=?1 AND barber_id=?2`).bind(companyId,barberId).first<SellerRow>();
 if(!row||!mpId(row.mp_user_id))return null;
 if(!Number.isFinite(Date.parse(row.expires_at)))return null;
 if(Date.parse(row.expires_at)<=Date.now()+120000){
  row=await refreshSeller(env,row);
  if(!row)return null;
 }
 const token=await decryptSecret(env,row.access_ciphertext);
 const notificationUrl=sellerNotificationUrl(env,companyId,barberId);
 return token&&notificationUrl?{token,account_id:row.mp_user_id,notificationUrl,requireCollectorId:true}:null;
}
