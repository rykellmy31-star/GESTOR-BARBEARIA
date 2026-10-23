import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {
 STAGING, PRODUCTION, productionTemplateIssues, inspectResources, auditProductionResources
} from "./production-inventory-readonly.mjs";

const template=JSON.parse(readFileSync(new URL("../wrangler.production.template.jsonc",import.meta.url),"utf8"));
const accountId="b".repeat(32);
const token="fictitious-only-read-account-token";
const uuid="11111111-1111-4111-8111-111111111111";
const dbsStage=[{name:STAGING.d1,uuid}];
const dbsProd=[];
const r2Stage={buckets:[{name:STAGING.r2}]};
const r2Prod={buckets:[]};
const workers=[{id:STAGING.worker}];

test("template de produção: recursos próprios, segredos ausentes, domínio e cron não ativados",()=>{
 assert.deepEqual(productionTemplateIssues(template),[]);
 assert.equal(template.name,PRODUCTION.worker);
 assert.equal(template.d1_databases[0].database_name,PRODUCTION.d1);
 assert.equal(template.r2_buckets[0].bucket_name,PRODUCTION.r2);
 assert.ok(!JSON.stringify(template).includes("MP_ACCESS_TOKEN"));
 assert.ok(!Object.hasOwn(template,"routes"));
 assert.equal(template.vars.TIGU_STAGING,"0");
 assert.deepEqual(template.triggers.crons,[]);
});

test("impede ligar gateways, mock, cron, DNS e banco de staging no template",()=>{
 const failures=[
   c=>{c.name=STAGING.worker;},
   c=>{c.vars.TIGU_STAGING="1";},
   c=>{c.vars.WHATSAPP_MOCK="1";},
   c=>{c.vars.PAYMENTS_MOCK="1";},
   c=>{c.vars.MP_ACCESS_TOKEN="secret-exposed";},
   c=>{c.vars.MERCHANT_PIX_ENABLED="1";},
   c=>{c.vars.PUBLIC_URL="https://agendamentos.crjornada.com/";},
   c=>{c.triggers.crons=["*/1 * * * *"];},
   c=>{c.routes=[{pattern:"agendamentos.crjornada.com/*"}];},
   c=>{c.d1_databases[0].database_name=STAGING.d1;},
   c=>{c.d1_databases[0].database_id=uuid;},
   c=>{c.r2_buckets[0].bucket_name=STAGING.r2;},
   c=>{c.assets.run_worker_first=[];},
   c=>{c.compatibility_flags=[];}
 ];
 for(const change of failures){
   const cfg=structuredClone(template);change(cfg);
   assert.ok(productionTemplateIssues(cfg).length,"An unsafe prod template was accepted");
 }
});

test("preflight exige staging presente e todos os novos nomes livres",()=>{
 assert.deepEqual(inspectResources(dbsStage,dbsProd,r2Stage,r2Prod,workers),{
   staging_verified:true,production_targets_absent:true,
   safe_to_prepare:true,production_activated:false
 });
 for(const [sd,pd,sr,pr,w] of [
   [[],dbsProd,r2Stage,r2Prod,workers],
   [dbsStage,dbsProd,{buckets:[]},r2Prod,workers],
   [dbsStage,dbsProd,r2Stage,r2Prod,[]],
   [dbsStage,dbsProd,r2Stage,r2Prod,[...workers,{id:PRODUCTION.worker}]],
   [dbsStage,[{name:PRODUCTION.d1,uuid}],r2Stage,r2Prod,workers],
   [dbsStage,dbsProd,r2Stage,{buckets:[{name:PRODUCTION.r2}]},workers],
   [dbsStage.concat(dbsStage),dbsProd,r2Stage,r2Prod,workers]
 ])assert.throws(()=>inspectResources(sd,pd,sr,pr,w));
});

function mockNetwork({prodExists=false,healthStaging=true,badAuth=false}={}){
 const calls=[];
 const prefix="https://api.cloudflare.com/client/v4/accounts/"+accountId;
 const results={
   [prefix+"/d1/database?name="+STAGING.d1]:dbsStage,
   [prefix+"/d1/database?name="+PRODUCTION.d1]:
     prodExists?[{name:PRODUCTION.d1,uuid:uuid}]:dbsProd,
   [prefix+"/r2/buckets?name_contains="+STAGING.r2]:r2Stage,
   [prefix+"/r2/buckets?name_contains="+PRODUCTION.r2]:r2Prod,
   [prefix+"/workers/scripts"]:workers,
 };
 const fetcher=async (url,options)=>{
   calls.push({url,method:options.method});
   assert.equal(options.method,"GET","Mutação remota proibida");
   if(Object.hasOwn(results,url)){
     assert.equal(options.headers.Authorization,"Bearer "+token);
     if(badAuth)return {ok:false,status:403};
     return {ok:true,json:async()=>({success:true,result:results[url]})};
   }
   if(url==="https://tigu-staging.netssh3-0.workers.dev/api/health"||
      url==="https://agendamentos.crjornada.com/api/health")
     return {status:200,json:async()=>({
       ok:true,staging:healthStaging,d1:true,r2:true,
       security:{session_secret_ready:true,encryption_key_ready:true}
     })};
   throw Error("Forbidden network request "+url);
 };
 return {fetcher,calls};
}

test("auditoria completa faz somente 7 GET sem criar recursos nem ativar cobrança",async()=>{
 const {fetcher,calls}=mockNetwork();
 const result=await auditProductionResources({token,accountId,fetcher});
 assert.equal(calls.length,7);
 assert.ok(calls.every(c=>c.method==="GET"));
 assert.equal(result.resources_created,0);
 assert.equal(result.customer_data_copied,false);
 assert.equal(result.domain_still_on_staging,true);
 assert.equal(result.payment_enabled,false);
 assert.equal(result.whatsapp_enabled,false);
 assert.equal(result.dns_changed,false);
 assert.ok(!JSON.stringify(result).includes(token));
 assert.ok(!JSON.stringify(result).includes(uuid));
});

test("preflight para sem token, credenciais ruins, conflito e domínio desligado",async()=>{
 let calls=0;
 const errorFetch=()=>{calls++;throw Error("Network forbidden");};
 await assert.rejects(auditProductionResources({token:"",accountId,fetcher:errorFetch}),/Token/);
 await assert.rejects(auditProductionResources({token,accountId:"xxx",fetcher:errorFetch}),/Token/);
 assert.equal(calls,0);
 await assert.rejects(auditProductionResources({token,accountId,
   fetcher:mockNetwork({prodExists:true}).fetcher}),/produção/);
 await assert.rejects(auditProductionResources({token,accountId,
   fetcher:mockNetwork({healthStaging:false}).fetcher}),/Staging/);
 await assert.rejects(auditProductionResources({token,accountId,
   fetcher:mockNetwork({badAuth:true}).fetcher}),/HTTP 403/);
});
