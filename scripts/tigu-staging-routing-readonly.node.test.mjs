import test from "node:test";
import assert from "node:assert/strict";
import {classifyDomain,inspectTiguRouting} from "./tigu-staging-routing-readonly.mjs";
const official={reachable:true,staging:true,d1:true,r2:true,paymentsMock:false,whatsappMock:true};
const stage={...official};

test("domínio oficial com staging: true bloqueia atualização, mesmo com Worker presente",()=>{
  const result=classifyDomain(official,stage,[{hostname:"agendamentos.crjornada.com",service:"tigu-staging",enabled:true,zone_name:"crjornada.com"}],["tigu-staging"]);
  assert.equal(result.safe_to_update_staging,false);
  assert.equal(result.official_uses_staging_worker,true);
});
test("sem autorização/segredos a consulta somente leitura continua bloqueando deploy",async()=>{
  const calls=[];
  const r=await inspectTiguRouting({fetcher:async(url,opts)=>{
    calls.push({url,method:opts.method});
    return {status:200,json:async()=>({service:"tigu-api",staging:true,d1:true,r2:true,payments:{mock:false},whatsapp:{mock:true}})};
  }});
  assert.equal(r.safe_to_update_staging,false);
  assert.equal(r.cloudflare_inventory,"unavailable_missing_repo_secret_or_account_id");
  assert.equal(calls.length,2);
  assert.ok(calls.every(c=>c.method==="GET"));
});
test("todos os caminhos remotos usam somente GET e nunca fornecem tokens no relatório",async()=>{
  const calls=[];
  const result=await inspectTiguRouting({
    token:"test-token-only",accountId:"a".repeat(32),
    fetcher:async(url,opts)=>{
      calls.push({url,method:opts.method});
      if(url.includes("workers/domains"))return {status:200,json:async()=>({success:true,result:[{hostname:"agendamentos.crjornada.com",service:"tigu-staging",enabled:true,zone_name:"crjornada.com"}]})};
      if(url.includes("workers/scripts"))return {status:200,json:async()=>({success:true,result:[{id:"tigu-staging"}]})};
      if(url.includes("/d1/database"))return {status:200,json:async()=>({success:true,result:[{name:"tigu-staging-db"}]})};
      if(url.includes("/r2/buckets"))return {status:200,json:async()=>({success:true,result:{buckets:[{name:"tigu-staging-media"}]}})};
      return {status:200,json:async()=>({service:"tigu-api",staging:true,d1:true,r2:true,payments:{mock:false},whatsapp:{mock:true}})};
    },
  });
  assert.equal(calls.length,6);
  assert.ok(calls.every(c=>c.method==="GET"));
  assert.equal(result.safe_to_update_staging,false);
  assert.equal(result.stage_inventory.d1,true);
  assert.equal(result.stage_inventory.r2,true);
  assert.ok(!JSON.stringify(result).includes("test-token-only"));
});
test("só marca como seguro quando o domínio oficial não é staging e os recursos estão segregados",()=>{
  const report=classifyDomain({...official,staging:false},{...stage,staging:true},
    [{hostname:"agendamentos.crjornada.com",service:"tigu-production",enabled:true,zone_name:"crjornada.com"}],["tigu-staging","tigu-production"]);
  assert.equal(report.safe_to_update_staging,true);
});
