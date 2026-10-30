import test from "node:test";
import assert from "node:assert/strict";
import {NAMES,preflightInventory,makeConfig,deployIsolated} from "./tigu-isolated-deploy-once.mjs";
const domains=[{hostname:"agendamentos.crjornada.com",service:"tigu-staging",enabled:true}];
const template={
  name:"tigu-staging",main:"api/index.ts",compatibility_date:"2025-01-01",
  compatibility_flags:["nodejs_compat"],
  vars:{APP_ENV:"production",TIGU_STAGING:"1",GRAPH_API_VERSION:"v23.0",WHATSAPP_MOCK:"1",PAYMENTS_MOCK:"0"},
  assets:{directory:"./dist",binding:"ASSETS",not_found_handling:"single-page-application",run_worker_first:["/api/*","/uploads/*"]},
  triggers:{crons:[]},
  d1_databases:[{binding:"DB",database_name:"tigu-staging-db",database_id:"REPLACE_WITH_ID",migrations_dir:"migrations"}],
  r2_buckets:[{binding:"MEDIA",bucket_name:"tigu-staging-media"}],
};
const inv={dbs:[],buckets:{buckets:[]},workers:[{id:"tigu-staging"}],domains};
const uuid="e0d93f78-6fbc-4e56-b860-70216c61522a";
test("names for isolation are never official or previous staging resources",()=>{
  assert.notEqual(NAMES.worker,"tigu-staging");
  assert.notEqual(NAMES.worker,"tigu-production");
  assert.notEqual(NAMES.database,"tigu-staging-db");
  assert.notEqual(NAMES.bucket,"tigu-staging-media");
  assert.equal(NAMES.domain,"agendamentos.crjornada.com");
});
test("inventory refuses any preexisting new Worker/D1/R2",()=>{
  assert.equal(preflightInventory(inv).official_unchanged,true);
  for(const bad of [
    {...inv,dbs:[{name:NAMES.database}]},
    {...inv,buckets:{buckets:[{name:NAMES.bucket}]}},
    {...inv,workers:[...inv.workers,{id:NAMES.worker}]},
    {...inv,domains:[...inv.domains,{hostname:"test.example.com",service:NAMES.worker}]},
    {...inv,domains:[{hostname:NAMES.domain,service:"tigu-production",enabled:true}]},
    {...inv,domains:[]},
  ])assert.throws(()=>preflightInventory(bad));
});
test("generated config has only isolated resources and manual billing",()=>{
  const cfg=makeConfig(uuid,template);
  assert.equal(cfg.name,NAMES.worker);
  assert.equal(cfg.vars.TIGU_PLATFORM_BILLING_MODE,"manual");
  assert.equal(cfg.vars.TIGU_STAGING,"1");
  assert.equal(cfg.vars.WHATSAPP_MOCK,"1");
  assert.equal(cfg.vars.PAYMENTS_MOCK,"0");
  assert.deepEqual(cfg.triggers.crons,[]);
  assert.equal(cfg.workers_dev,true);
  assert.equal(cfg.d1_databases[0].database_id,uuid);
  assert.equal(cfg.d1_databases[0].database_name,NAMES.database);
  assert.equal(cfg.r2_buckets[0].bucket_name,NAMES.bucket);
  assert.ok(!cfg.routes);
});
test("rejects unsafe staging template before deploying to Worker",()=>{
  for(const vars of [
    {TIGU_STAGING:"0"},
    {WHATSAPP_MOCK:"0"},
    {PAYMENTS_MOCK:"1"},
    {APP_ENV:"development"},
  ])assert.throws(()=>makeConfig(uuid,{...template,vars:{...template.vars,...vars}}));
  assert.throws(()=>makeConfig("not-uuid",template));
});
test("without credentials no Cloudflare API call is made",async()=>{
  let calls=0;
  await assert.rejects(()=>deployIsolated({token:"",accountId:"",fetcher:()=>{calls++;throw Error("should not call");}}));
  assert.equal(calls,0);
});
