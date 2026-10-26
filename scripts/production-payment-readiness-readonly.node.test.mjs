import test from "node:test";
import assert from "node:assert/strict";
import {inspectPaymentReadiness} from "./production-payment-readiness-readonly.mjs";
const accountId="0".repeat(32);
const token="token-for-readonly-ci-tests";
function response(data,status=200){return {
 ok:status===200,status,async json(){return {success:status===200,result:data}}
};}
function fake(worker=true){
 const calls=[];
 const fetcher=async(u,opts)=>{
  calls.push({url:u,method:opts.method});
  assert.equal(opts.method,"GET","Never write Cloudflare resources");
  if(u.endsWith("/workers/scripts"))return response([{id:"tigu-staging"},...(worker?[{id:"tigu-production"}]:[])]);
  if(u.includes("/d1/database"))return response([{name:"tigu-production-db"}]);
  if(u.includes("/r2/buckets"))return response({buckets:[{name:"tigu-production-media"}]});
  if(u.endsWith("/secrets"))return response([{name:"SESSION_SECRET",type:"secret_text"}]);
  if(u.endsWith("/settings"))return response({bindings:[
   {name:"APP_ENV",type:"plain_text",text:"production"},
   {name:"PAYMENTS_MOCK",type:"plain_text",text:"0"},
   {name:"MERCHANT_PIX_ENABLED",type:"plain_text",text:"0"}
  ]});
  throw Error("Unexpected URL");
 };
 return {calls,fetcher};
}
test("without production Worker detects existing D1/R2 and makes GETs only",async()=>{
 const f=fake(false);
 const r=await inspectPaymentReadiness({token,accountId,fetcher:f.fetcher});
 assert.equal(r.production_d1_exists,true);
 assert.equal(r.production_r2_exists,true);
 assert.equal(r.production_worker_exists,false);
 assert.equal(f.calls.length,3);
 assert.equal(r.changed_resources,0);
});
test("inspects only secret names and flags, never secret values",async()=>{
 const f=fake(true);
 const r=await inspectPaymentReadiness({token,accountId,fetcher:f.fetcher});
 assert.equal(r.production_worker_exists,true);
 assert.equal(r.required_secret_names.count_present,1);
 assert.equal(r.production_flags.real_pix_enabled,false);
 assert.equal(JSON.stringify(r).includes("token-for"),false);
 assert.equal(f.calls.length,5);
});
test("invalid credentials stop before any network requests",async()=>{
 const f=fake();
 await assert.rejects(
  inspectPaymentReadiness({token:"",accountId,fetcher:f.fetcher}),
  /Credenciais Cloudflare/
 );
 assert.equal(f.calls.length,0);
});
