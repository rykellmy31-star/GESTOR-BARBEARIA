/// <reference types="@cloudflare/vitest-plugin/types" />
import {beforeAll,afterEach,describe,it,expect,vi} from "vitest";
import {env} from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import {applyBookingMigrations} from "./helpers/booking-migrations";
import type {Env} from "../api/types";
import {configureMerchant,loadMerchant,merchantPixReady,merchantStatus,
 createMerchantPayment} from "../api/lib/merchant-payments";
import {confirmOrderPix} from "../api/lib/order-payments";

const db=env.DB as D1Database;
const tokenA="APP_USR-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const tokenB="APP_USR-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const secureEnv={...env,DB:db,APP_ENV:"production",TIGU_STAGING:undefined,
 MERCHANT_PIX_ENABLED:"1",PAYMENTS_MOCK:"0",
 MSG_ENC_KEY:"merchant-isolation-secret-strong-1234567890",
 PUBLIC_URL:"https://tigu.example.com/"} as Env;
beforeAll(async()=>{
 for(const stmt of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean))
  await db.prepare(stmt).run();
 await applyBookingMigrations(db);
});
afterEach(()=>vi.unstubAllGlobals());
async function company(){
 const res=await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Barbearia Teste')")
  .bind("merchant-"+crypto.randomUUID()).run();
 return Number(res.meta.last_row_id);
}
function mockIdentity(){
 vi.stubGlobal("fetch",async(url:string,opts:RequestInit)=>{
  if(!url.endsWith("/users/me"))throw Error("URL inesperada");
  const account=String((opts.headers as Record<string,string>).Authorization).includes(tokenA)?"1001":"2002";
  return new Response(JSON.stringify({id:Number(account)}),{status:200});
 });
}
describe("Mercado Pago pertence ao dono da barbearia",()=>{
 it("cifra tokens, não expõe segredos e separa duas empresas",async()=>{
  const a=await company(),b=await company();
  mockIdentity();
  expect((await configureMerchant(secureEnv,a,tokenA,"assinatura-webhook-a-muito-longa")).ok).toBe(true);
  expect((await configureMerchant(secureEnv,b,tokenB,"assinatura-webhook-b-muito-longa")).ok).toBe(true);
  const aStatus=await merchantStatus(secureEnv,a),bStatus=await merchantStatus(secureEnv,b);
  expect(aStatus).toMatchObject({connected:true,pix_available:true,account_id:"1001"});
  expect(bStatus).toMatchObject({connected:true,pix_available:true,account_id:"2002"});
  expect(aStatus.webhook_url).not.toEqual(bStatus.webhook_url);
  expect(JSON.stringify(aStatus)).not.toContain(tokenA);
  const stored=await db.prepare("SELECT access_token_enc,webhook_secret_enc FROM company_payment_integrations WHERE company_id=?1")
   .bind(a).first<{access_token_enc:string;webhook_secret_enc:string}>();
  expect(stored?.access_token_enc).toMatch(/^v1\./);
  expect(stored?.access_token_enc).not.toContain(tokenA);
  expect(stored?.webhook_secret_enc).not.toContain("assinatura-webhook-a");
  expect((await loadMerchant(secureEnv,a))?.token).toBe(tokenA);
  expect((await loadMerchant(secureEnv,b))?.token).toBe(tokenB);
  expect(await merchantPixReady({...secureEnv,TIGU_STAGING:"1"},a)).toBe(false);
  expect(await merchantPixReady({...secureEnv,MERCHANT_PIX_ENABLED:"0"},a)).toBe(false);
 });
 it("novo Pix usa token e URL do vendedor, nunca conta da plataforma",async()=>{
  const a=await company();mockIdentity();
  await configureMerchant(secureEnv,a,tokenA,"assinatura-webhook-a-muito-longa");
  const merchant=(await loadMerchant(secureEnv,a))!;
  vi.stubGlobal("fetch",async(url:string,opts:RequestInit)=>{
   expect(url).toBe("https://api.mercadopago.com/v1/payments");
   expect((opts.headers as Record<string,string>).Authorization).toBe("Bearer "+tokenA);
   const body=JSON.parse(opts.body as string);
   expect(body.notification_url).toBe(merchant.notificationUrl);
   expect(body.transaction_amount).toBe(29.99);
   return new Response(JSON.stringify({id:987654,collector_id:1001,
    point_of_interaction:{transaction_data:{qr_code:"PIX-DA-BARBEARIA"}}}),{status:201});
  });
  const result=await createMerchantPayment(merchant,{amountCents:2999,
   reference:"TIGU-ORDER-TEST-ABC",description:"Produtos teste",payerEmail:"cliente@example.test"});
  expect(result).toMatchObject({ok:true,providerPaymentId:"987654",qrCodeText:"PIX-DA-BARBEARIA"});
 });
 it("confirma Pix de produto na conta correta e impede vinculação financeira cruzada",async()=>{
  const a=await company(),b=await company();mockIdentity();
  await configureMerchant(secureEnv,a,tokenA,"assinatura-webhook-a-muito-longa");
  await configureMerchant(secureEnv,b,tokenB,"assinatura-webhook-b-muito-longa");
  const order=await db.prepare("INSERT INTO orders(company_id,code,customer_name,customer_phone,total_cents,payment_choice,customer_email) VALUES (?1,?2,'Cliente','5573999999999',2999,'pix','cliente@example.test')")
   .bind(a,"PED-"+crypto.randomUUID()).run();
  const id=Number(order.meta.last_row_id),reference="TIGU-ORDER-TEST-"+crypto.randomUUID();
  await expect(db.prepare("INSERT INTO order_payments(company_id,order_id,code,lookup_token,amount_cents,status) VALUES (?1,?2,?3,?4,2999,'pending')")
   .bind(b,id,"OUTRO-"+crypto.randomUUID(),crypto.randomUUID()).run()).rejects.toThrow();
  await db.prepare("INSERT INTO order_payments(company_id,order_id,code,lookup_token,amount_cents,provider_payment_id,status) VALUES (?1,?2,?3,?4,2999,'543210','pending')")
   .bind(a,id,reference,crypto.randomUUID()).run();
  vi.stubGlobal("fetch",async(url:string,opts:RequestInit)=>{
   expect(url).toContain("/v1/payments/543210");
   expect((opts.headers as Record<string,string>).Authorization).toBe("Bearer "+tokenA);
   return new Response(JSON.stringify({id:543210,collector_id:1001,status:"approved",
    external_reference:reference,currency_id:"BRL",payment_method_id:"pix",transaction_amount:29.99}),{status:200});
  });
  expect(await confirmOrderPix(secureEnv,b,"543210")).toMatchObject({ok:false,status:"not_found"});
  expect(await confirmOrderPix(secureEnv,a,"543210")).toMatchObject({ok:true,status:"paid"});
  expect(await confirmOrderPix(secureEnv,a,"543210")).toMatchObject({ok:true,status:"paid"});
  const paid=await db.prepare("SELECT status,paid_at FROM orders WHERE id=?1").bind(id).first<{status:string;paid_at:string|null}>();
  expect(paid?.status).toBe("pago");
  expect(paid?.paid_at).not.toBeNull();
 });
});
