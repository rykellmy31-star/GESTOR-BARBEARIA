/// <reference types="@cloudflare/vitest-plugin/types" />
import {beforeAll,afterEach,describe,it,expect,vi} from "vitest";
import {env} from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import {applyBookingMigrations} from "./helpers/booking-migrations";
import {encryptSecret} from "../api/lib/crypto";
import {sellerPixReady,sellerPaymentsEnabled,sellerNotificationUrl} from "../api/lib/seller-payments";
import {generateBookingPix,confirmBookingPix} from "../api/lib/booking-payments";
import type {Env} from "../api/types";

const db=env.DB as D1Database;
const sellerToken="APP_USR-SELLER-RECEIVER-ACCOUNT-SECRET";
const secure={...env,DB:db,APP_ENV:"production",TIGU_STAGING:undefined,
 MERCHANT_PIX_ENABLED:"1",PAYMENTS_MOCK:"0",PUBLIC_URL:"https://tigu.example.com/",
 MSG_ENC_KEY:"seller-payment-protected-encryption-secret-123456",
 MP_MARKETPLACE_CLIENT_ID:"client-application-id",
 MP_MARKETPLACE_CLIENT_SECRET:"secret-of-marketplace-application",
 MP_MARKETPLACE_WEBHOOK_SECRET:"signed-marketplace-webhook-secret-123"} as Env;
beforeAll(async()=>{
 for(const s of schema.replace(/--[^\n]*/g,"").split(";").map(x=>x.trim()).filter(Boolean))
  await db.prepare(s).run();
 await applyBookingMigrations(db);
});
afterEach(()=>vi.unstubAllGlobals());

async function fixture(withSeller=true){
 const suffix=crypto.randomUUID();
 const co=await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Pix Recebedor Teste')")
  .bind("seller-"+suffix).run();
 const companyId=Number(co.meta.last_row_id);
 const b=await db.prepare("INSERT INTO barbers(company_id,slug,name) VALUES (?1,?2,'Barbeiro')")
  .bind(companyId,"barber-"+suffix).run();
 const barberId=Number(b.meta.last_row_id);
 const u=await db.prepare("INSERT INTO users(name,email,password_hash) VALUES ('Profissional',?1,'hash-ficticio')")
  .bind("barber-"+suffix+"@example.test").run();
 const userId=Number(u.meta.last_row_id);
 const mpUserId=String(10000+barberId);
 await db.prepare("INSERT INTO company_memberships(company_id,user_id,role,barber_id) VALUES (?1,?2,'barber',?3)")
  .bind(companyId,userId,barberId).run();
 const service=await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,?2,'Corte',2999,30)")
  .bind(companyId,"cut-"+suffix).run();
 const booking=await db.prepare(
  "INSERT INTO bookings(company_id,code,barber_id,service_id,starts_at,ends_at,price_cents,status,customer_name,customer_phone,customer_email,cancel_token,payment_choice) "+
  "VALUES (?1,?2,?3,?4,'2026-11-10T13:00:00Z','2026-11-10T13:30:00Z',2999,'confirmado','Cliente','5573999999999','cliente@example.test',?5,'pix')")
  .bind(companyId,"BOOK-"+suffix,barberId,Number(service.meta.last_row_id),crypto.randomUUID()).run();
 if(withSeller){
  await db.prepare("INSERT INTO seller_mp_accounts(company_id,barber_id,mp_user_id,access_ciphertext,refresh_ciphertext,expires_at,connected_by,connected_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)")
   .bind(companyId,barberId,mpUserId,await encryptSecret(secure,sellerToken),
     await encryptSecret(secure,"REFRESH-SELLER-SECRET-ACCOUNT"),
     new Date(Date.now()+3600000).toISOString(),userId,new Date().toISOString()).run();
 }
 return {companyId,barberId,mpUserId,bookingId:Number(booking.meta.last_row_id)};
}

describe("Pix real separado pela conta OAuth de cada profissional",()=>{
 it("bloqueia staging, mock e aplicação incompleta; permite OAuth seguro",async()=>{
  const {companyId,barberId}=await fixture();
  expect(sellerPaymentsEnabled(secure)).toBe(true);
  expect(await sellerPixReady(secure,companyId,barberId)).toBe(true);
  expect(await sellerPixReady({...secure,TIGU_STAGING:"1"},companyId,barberId)).toBe(false);
  expect(await sellerPixReady({...secure,MP_MARKETPLACE_WEBHOOK_SECRET:""},companyId,barberId)).toBe(false);
  expect(await sellerPixReady({...secure,MERCHANT_PIX_ENABLED:"0"},companyId,barberId)).toBe(false);
  expect(sellerNotificationUrl(secure,companyId,barberId)).toBe(
   "https://tigu.example.com/api/webhooks/seller-mercadopago/"+companyId+"/"+barberId);
 });
 it("não oferece cobrança quando o profissional não conectou Mercado Pago",async()=>{
  const {companyId,bookingId}=await fixture(false);
  vi.stubGlobal("fetch",()=>{throw Error("Não pode acessar o Mercado Pago");});
  expect((await generateBookingPix(secure,companyId,bookingId)).status).toBe("unavailable");
 });
 it("cobra na conta do barbeiro, evita duplicação e confirma por GET com isolamento",async()=>{
  const {companyId,barberId,bookingId,mpUserId}=await fixture();
  let posts=0;
  vi.stubGlobal("fetch",async(url:string,opts:RequestInit)=>{
   expect(url).toBe("https://api.mercadopago.com/v1/payments");
   expect(opts.method).toBe("POST");
   expect((opts.headers as Record<string,string>).Authorization).toBe("Bearer "+sellerToken);
   const body=JSON.parse(opts.body as string);
   expect(body.notification_url).toBe(sellerNotificationUrl(secure,companyId,barberId));
   expect(body.transaction_amount).toBe(29.99);
   posts++;
   return new Response(JSON.stringify({id:991337,collector_id:Number(mpUserId),
    point_of_interaction:{transaction_data:{qr_code:"000201PIX-DO-PROFISSIONAL"}}}),{status:201});
  });
  expect(await generateBookingPix(secure,companyId,bookingId)).toMatchObject({
    status:"pending",amount_cents:2999,qr_code_text:"000201PIX-DO-PROFISSIONAL"
  });
  expect((await generateBookingPix(secure,companyId,bookingId)).status).toBe("pending");
  expect(posts).toBe(1);
  const p=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?1")
   .bind(bookingId).first<{code:string;receiver_barber_id:number;receiver_mp_user_id:string}>();
  expect(p?.receiver_barber_id).toBe(barberId);
  expect(p?.receiver_mp_user_id).toBe(mpUserId);
  await expect(db.prepare("DELETE FROM seller_mp_accounts WHERE company_id=?1 AND barber_id=?2")
    .bind(companyId,barberId).run()).rejects.toThrow();
  vi.stubGlobal("fetch",async(url:string,opts:RequestInit)=>{
   expect(url).toBe("https://api.mercadopago.com/v1/payments/991337");
   expect((opts.headers as Record<string,string>).Authorization).toBe("Bearer "+sellerToken);
   return new Response(JSON.stringify({id:991337,status:"approved",collector_id:2001,
    external_reference:p!.code,currency_id:"BRL",payment_method_id:"pix",
    transaction_amount:29.99}),{status:200});
  });
  expect(await confirmBookingPix(secure,companyId,"991337","merchant")).toMatchObject({ok:false,status:"not_found"});
  expect(await confirmBookingPix(secure,companyId+999,"991337","seller")).toMatchObject({ok:false,status:"not_found"});
  expect(await confirmBookingPix(secure,companyId,"991337","seller")).toMatchObject({ok:true,status:"paid"});
  const final=await db.prepare("SELECT status FROM booking_payments WHERE booking_id=?1")
    .bind(bookingId).first<{status:string}>();
  expect(final?.status).toBe("paid");
 });
});
