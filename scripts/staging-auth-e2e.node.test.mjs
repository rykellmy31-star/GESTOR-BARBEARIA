import test from "node:test";
import assert from "node:assert/strict";
import { checkStagingUrl,isIsolatedHealth,authenticatedStagingChecks } from "./staging-auth-e2e.mjs";

test("somente Worker de homologação aceita mutações fictícias",()=>{
  assert.equal(checkStagingUrl("https://tigu-staging.netssh3-0.workers.dev/"),
    "https://tigu-staging.netssh3-0.workers.dev");
  for(const url of [
    "https://tigu-platform.netssh3-0.workers.dev/",
    "https://tigu-staging.netssh3-0.workers.dev/api",
    "https://tigu-staging.netssh3-0.workers.dev/?x=1",
    "http://tigu-staging.netssh3-0.workers.dev/",
    "https://tigu-staging.netssh3-0.workers.dev.evil.invalid/",
  ]) assert.throws(()=>checkStagingUrl(url),/Somente/);
});
test("exige D1/R2, secrets e bloqueios explícitos de pagamentos/Meta",()=>{
  const ok={ok:true,service:"tigu-api",staging:true,d1:true,r2:true,
    security:{session_secret_ready:true,encryption_key_ready:true},
    payments:{mercadopago:false,mock:false},
    whatsapp:{embedded:false,mock:true}};
  assert.equal(isIsolatedHealth(ok),true);
  for(const mutate of [
    h=>{h.staging=false},h=>{h.d1=false},h=>{h.r2=false},
    h=>{h.security.session_secret_ready=false},
    h=>{h.security.encryption_key_ready=false},
    h=>{h.payments.mercadopago=true},h=>{h.payments.mock=true},
    h=>{h.whatsapp.embedded=true},h=>{h.whatsapp.mock=false},
  ]){const h=structuredClone(ok);mutate(h);assert.equal(isIsolatedHealth(h),false);}
});
test("ambiente diferente de staging é rejeitado ANTES de criar contas",async()=>{
  let calls=0;
  await assert.rejects(authenticatedStagingChecks({
    url:"https://tigu-production.example.com",fetcher:async()=>{calls++;throw Error("never");}
  }),/Somente/);
  assert.equal(calls,0);
});
test("health não isolado interrompe testes autenticados sem POST",async()=>{
  const methods=[];
  await assert.rejects(authenticatedStagingChecks({
    url:"https://tigu-staging.netssh3-0.workers.dev/",
    fetcher:async (url,opt)=>{
      methods.push(opt.method);
      return {status:200,json:async()=>({ok:true,service:"tigu-api",staging:false})};
    },
  }),/Proteção da identidade/);
  assert.deepEqual(methods,["GET"]);
});
