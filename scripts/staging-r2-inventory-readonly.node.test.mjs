import test from "node:test";
import assert from "node:assert/strict";
import { inventoryR2 } from "./staging-r2-inventory-readonly.mjs";
const id="a".repeat(32), token="strong-fictitious-audit-token",sourceUuid="11111111-1111-4111-8111-111111111111";
const source="tigu-staging-media", dest="tigu-recovery-20261021-39699187805-r2";
const api="https://api.cloudflare.com/client/v4/accounts/"+id;
function mocked({status=200,badCursor=false,seen=[],badShape=false}={}){
 return async (url,opts)=>{
  seen.push({url,method:opts.method,auth:opts.headers?.Authorization});
  assert.equal(opts.method,"GET");
  assert.equal(opts.headers.Authorization,"Bearer "+token);
  let result,result_info;
  if(url===api+"/d1/database?name=tigu-staging-db")
    result=[{name:"tigu-staging-db",uuid:sourceUuid}];
  else if(url===api+"/r2/buckets?name_contains=tigu-staging-media")
    result={buckets:[{name:source}]};
  else if(url===api+"/workers/scripts")
    result=[{id:"tigu-staging"}];
  else if(url.includes("/r2/buckets/"+source+"/objects?")){
    const u=new URL(url);
    if(u.searchParams.has("cursor")){
      result=[{key:"arquivo-privado-2",size:22}];
      result_info={is_truncated:badCursor,cursor:"same-cursor"};
    }else{
      result=[{key:"arquivo-privado-1",size:10}];
      result_info={is_truncated:true,cursor:"same-cursor"};
    }
  }else if(url.includes("/r2/buckets/"+dest+"/objects?")){
    result=[{key:"__tigu_recovery_test/a.bin",size:27}];
    result_info={is_truncated:false};
  }else throw Error("URL fora da lista allowlisted.");
  return {ok:status===200,status,json:async()=>({success:true,
   result:badShape&&url.includes("/objects?")?{}:result,result_info})};
 };
}
test("inventário R2 percorre todos os cursores sem modificar recursos ou exibir keys",async()=>{
 const seen=[];
 const report=await inventoryR2({accountId:id,token,fetcher:mocked({seen})});
 assert.deepEqual(report.source,{objects:2,bytes:32,pages:2,complete:true});
 assert.deepEqual(report.recovery,{objects:1,bytes:27,pages:1,complete:true});
 assert.equal(report.complete_inventory_verified,true);
 assert.equal(report.all_source_objects_restored,false);
 assert.equal(report.remote_writes,0);
 assert.ok(seen.every(c=>c.method==="GET"));
 assert.ok(!JSON.stringify(report).includes("arquivo-privado"));
 assert.ok(!JSON.stringify(report).includes(token));
 assert.ok(!JSON.stringify(report).includes(id));
});
test("cursor duplicado aborta inventário incompleto",async()=>{
 await assert.rejects(inventoryR2({accountId:id,token,fetcher:mocked({badCursor:true})}),
  /repetido/);
});
test("resposta inesperada aborta antes de declarar recuperação R2",async()=>{
 await assert.rejects(inventoryR2({accountId:id,token,fetcher:mocked({badShape:true})}),
  /incompleto ou inesperado/);
});
test("permissão negada aborta sem escrita ou vazamento de token",async()=>{
 const seen=[];
 await assert.rejects(inventoryR2({accountId:id,token,fetcher:mocked({status:403,seen})}),
  /não permitiu|negou|recusou/);
 assert.equal(seen.length,1);
 assert.ok(seen.every(x=>x.method==="GET"));
});
