import test from "node:test";
import assert from "node:assert/strict";
import { configureTurnstileStaging } from "./staging-turnstile-setup.mjs";

const id="b".repeat(32);
const token="fictional-cloudflare-secret-for-test-only";
const prefix="https://api.cloudflare.com/client/v4/accounts/"+id;
const widgetName="TIGU Leads Homologacao 2026";
function makeFixture({oldSecret=false,denyWidgets=false,badEnvironment=false,emptyBindings=false}={}){
 const calls=[],puts=[];
 const widgets=[];
 const installed=new Set(oldSecret?["SALES_TURNSTILE_SECRET"]:[]);
 let stage=badEnvironment?"0":"1";
 const fetcher=async (url,options={})=>{
   const method=options.method??"GET";
   calls.push({url,method});
   if(url==="https://tigu-staging.netssh3-0.workers.dev/api/health")
     return {ok:true,json:async()=>({ok:true,staging:true,d1:true,r2:true})};
   if(url==="https://tigu-staging.netssh3-0.workers.dev/api/marketing/lead-config")
     return {ok:true,json:async()=>({required:true,enabled:true,
       site_key:"0x4AAAfictionalSitekey123456"})};
   if(url===prefix+"/d1/database?name=tigu-staging-db")
     return {ok:true,json:async()=>({success:true,result:[{
       uuid:"11111111-1111-4111-8111-111111111111",name:"tigu-staging-db"}]})};
   if(url===prefix+"/r2/buckets?name_contains=tigu-staging-media")
     return {ok:true,json:async()=>({success:true,result:{buckets:[{name:"tigu-staging-media"}]}})};
   if(url===prefix+"/workers/scripts")
     return {ok:true,json:async()=>({success:true,result:[{id:"tigu-staging"}]})};
   if(url===prefix+"/workers/scripts/tigu-staging/settings") {
     const bindings=emptyBindings?[]:[
       {name:"TIGU_STAGING",type:"plain_text",text:stage},
       {name:"DB",type:"d1"},{name:"MEDIA",type:"r2_bucket"},
       ...[...installed].map(name=>({name,type:"secret_text"})),
     ];
     return {ok:true,json:async()=>({success:true,result:{bindings}})};
   }
   if(url===prefix+"/challenges/widgets?per_page=1000")
     return denyWidgets?{ok:false,status:403}:{
       ok:true,json:async()=>({success:true,result:widgets})};
   if(url===prefix+"/challenges/widgets"&&method==="POST"){
     assert.deepEqual(JSON.parse(options.body),{
       name:widgetName,mode:"managed",
       domains:["agendamentos.crjornada.com","tigu-staging.netssh3-0.workers.dev"]});
     const result={name:widgetName,sitekey:"0x4AAAfictionalSitekey123456",
       secret:"0x4AAAfictionalPrivateSecret123456",
       domains:["agendamentos.crjornada.com","tigu-staging.netssh3-0.workers.dev"]};
     widgets.push(result);
     return {ok:true,json:async()=>({success:true,result})};
   }
   throw Error("Unexpected endpoint "+method+" "+url);
 };
 const putSecret=async(key,value)=>{
   assert.ok(!oldSecret,"Cannot overwrite existing secret");
   puts.push({key,value});
   installed.add(key);
 };
 return {fetcher,putSecret,calls,puts};
}

test("configura dois segredos novos sem permitir vazamento ou recurso de produção",async()=>{
 const f=makeFixture();
 const result=await configureTurnstileStaging({token,accountId:id,fetcher:f.fetcher,putSecret:f.putSecret});
 assert.equal(result.turnstile_configured,true);
 assert.equal(result.staging_health_verified,true);
 assert.equal(result.credentials_exposed,false);
 assert.equal(result.production_modified,false);
 assert.equal(result.real_payment_enabled,false);
 assert.equal(result.real_whatsapp_enabled,false);
 assert.deepEqual(f.puts.map(x=>x.key),["SALES_TURNSTILE_SECRET","SALES_TURNSTILE_SITE_KEY"]);
 assert.equal(f.calls.filter(x=>x.method==="POST").length,1);
 assert.ok(!JSON.stringify(result).includes("fictionalPrivateSecret"));
 assert.ok(!JSON.stringify(result).includes(token));
});

test("segredo existente falha antes de criar widget ou alterar segredo",async()=>{
 const f=makeFixture({oldSecret:true});
 await assert.rejects(configureTurnstileStaging({
   token,accountId:id,fetcher:f.fetcher,putSecret:f.putSecret}),/já possui bindings/);
 assert.ok(f.calls.every(x=>x.method!=="POST"));
 assert.equal(f.puts.length,0);
});

test("sem permissão Account:Turnstile:Edit, termina sem qualquer escrita",async()=>{
 const f=makeFixture({denyWidgets:true});
 await assert.rejects(configureTurnstileStaging({
   token,accountId:id,fetcher:f.fetcher,putSecret:f.putSecret}),/HTTP 403/);
 assert.ok(f.calls.every(x=>x.method!=="POST"));
 assert.equal(f.puts.length,0);
});

test("worker não isolado e bindings ausentes impedem qualquer alteração",async()=>{
 for(const config of [{badEnvironment:true},{emptyBindings:true}]){
   const f=makeFixture(config);
   await assert.rejects(configureTurnstileStaging({
     token,accountId:id,fetcher:f.fetcher,putSecret:f.putSecret}),/isolamento staging/);
   assert.ok(f.calls.every(x=>x.method!=="POST"));
   assert.equal(f.puts.length,0);
 }
});
