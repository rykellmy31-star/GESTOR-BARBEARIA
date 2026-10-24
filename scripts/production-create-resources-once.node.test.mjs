import test from "node:test";
import assert from "node:assert/strict";
import {createProductionResources} from "./production-create-resources-once.mjs";
const token="fake-cloudflare-token-over-15-chars",accountId="a".repeat(32);
test("preflight tem que verificar staging e ausência dos destinos",async()=>{
 let writes=0;
 await assert.rejects(createProductionResources({
  token,accountId,audit:async()=>({staging_verified:true,production_targets_absent:false,domain_still_on_staging:true}),
  fetcher:async()=>{writes++;throw Error("não permitido");}
 }),/Preflight/);
 assert.equal(writes,0);
});
test("cria apenas D1 e R2 com nomes isolados, em ordem",async()=>{
 const calls=[];
 const out=await createProductionResources({
  token,accountId,
  audit:async()=>({staging_verified:true,production_targets_absent:true,domain_still_on_staging:true}),
  fetcher:async(url,opt)=>{
   const data=JSON.parse(opt.body);
   calls.push({url,method:opt.method,data});
   if(url.endsWith("/d1/database"))return {ok:true,json:async()=>({
    success:true,result:{name:"tigu-production-db",uuid:"12345678-1234-4123-8123-123456789012"}
   })};
   if(url.endsWith("/r2/buckets"))return {ok:true,json:async()=>({
    success:true,result:{name:"tigu-production-media"}
   })};
   throw Error("path inesperado");
  }
 });
 assert.equal(calls.length,2);
 assert.deepEqual(calls.map(c=>[c.method,c.data.name]),[
  ["POST","tigu-production-db"],["POST","tigu-production-media"]
 ]);
 assert.equal(out.domain_changed,false);
 assert.equal(out.production_worker_created,false);
 assert.equal(out.production_payments_enabled,false);
 assert.equal(out.staging_modified,false);
});
test("Cloudflare 403 interrompe antes do segundo POST",async()=>{
 let count=0;
 await assert.rejects(createProductionResources({
  token,accountId,
  audit:async()=>({staging_verified:true,production_targets_absent:true,domain_still_on_staging:true}),
  fetcher:async()=>{count++;return {ok:false,status:403}}
 }),/HTTP 403/);
 assert.equal(count,1);
});
