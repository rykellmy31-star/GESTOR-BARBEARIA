import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync,writeFileSync } from "node:fs";
import { recoverFullStagingR2 } from "./staging-r2-full-recovery-ci.mjs";

const token="fictitious-token-for-private-staging-test";
const accountId="b".repeat(32), uuid="11111111-1111-4111-8111-111111111111";
const runId="39700970822";
const source="tigu-staging-media", dest="tigu-recovery-full-20261021-"+runId+"-r2";
const base="https://api.cloudflare.com/client/v4/accounts/"+accountId;
function fixture({destinationExists=false,corrupt=false,sourceChanges=false}={}){
 const data=new Map([
  [source+"/a.png",Buffer.from("image-1")],
  [source+"/folder/b.webp",Buffer.from("image-two")],
  [source+"/__tigu_recovery_test/fixture.bin",Buffer.from("proof")],
 ]);
 const calls=[];
 let created=false,copies=0;
 const fetcher=async(url,opt)=>{
  calls.push({url,method:opt.method});
  assert.equal(opt.headers?.Authorization,"Bearer "+token);
  let result,result_info;
  if(url===base+"/d1/database?name=tigu-staging-db")result=[{name:"tigu-staging-db",uuid}];
  else if(url===base+"/r2/buckets?name_contains=tigu-staging-media")
   result={buckets:[{name:source}]};
  else if(url===base+"/workers/scripts")result=[{id:"tigu-staging"}];
  else if(url===base+"/r2/buckets?name_contains="+dest)
   result={buckets:destinationExists?[{name:dest}]:[]};
  else if(url===base+"/r2/buckets"&&opt.method==="POST"){
   assert.deepEqual(JSON.parse(opt.body),{name:dest});
   created=true;result={name:dest};
  }else if(url.startsWith(base+"/r2/buckets/")&&url.includes("/objects?")){
   const bucket=url.slice((base+"/r2/buckets/").length).split("/")[0];
   if(bucket!==source&&bucket!==dest)throw Error("Unexpected R2 bucket");
   const keys=[...data.entries()].filter(([k])=>k.startsWith(bucket+"/"));
   result=keys.map(([k,v])=>({
    key:k.slice(bucket.length+1),size:v.length,etag:"etag-"+v.length,
    http_metadata:{contentType:"image/png"}
   }));
   if(bucket===source&&sourceChanges&&copies>0)
    result.push({key:"future.png",size:10,etag:"later",http_metadata:{contentType:"image/png"}});
   result_info={is_truncated:false};
  }else throw Error("Unexpected Cloudflare API URL "+url);
  return {ok:true,json:async()=>({success:true,result,result_info})};
 };
 const exec=(bin,args)=>{
  assert.equal(bin,"npx");
  assert.deepEqual(args.slice(0,3),["wrangler","r2","object"]);
  assert.ok(args.includes("--remote"));
  const [op,path]=args.slice(3,5),file=args[args.indexOf("--file")+1];
  assert.ok(path.startsWith(source+"/")||path.startsWith(dest+"/"));
  if(op==="get"){
   if(!data.has(path))throw Error("Test object not found");
   if(corrupt&&path.startsWith(dest+"/"))writeFileSync(file,"tampered");
   else writeFileSync(file,data.get(path));
  }else if(op==="put"){
   assert.ok(path.startsWith(dest+"/"));
   assert.ok(created);
   data.set(path,readFileSync(file));copies++;
  }else throw Error("Unexpected Wrangler operation "+op);
 };
 return {fetcher,exec,calls,getCreated:()=>created};
}
test("recupera acervo integral em novo bucket: três objetos, sha e inventários",async()=>{
 const f=fixture();
 const r=await recoverFullStagingR2({
  token,accountId,runId,fetcher:f.fetcher,exec:f.exec
 });
 assert.equal(r.objects_verified,3);
 assert.equal(r.bytes_verified,7+9+5);
 assert.equal(r.all_source_objects_restored,true);
 assert.equal(r.sha256_per_object_verified,true);
 assert.equal(r.existing_recovery_untouched,true);
 assert.equal(r.production_modified,false);
 assert.equal(f.calls.filter(x=>x.method==="POST").length,1);
 assert.ok(!JSON.stringify(r).includes(token));
 assert.ok(!JSON.stringify(r).includes("folder/b.webp"));
});
test("destino existente é bloqueado antes de copiar ou escrever",async()=>{
 const f=fixture({destinationExists:true});
 await assert.rejects(recoverFullStagingR2({token,accountId,runId,
  fetcher:f.fetcher,exec:f.exec}),/já existe/);
 assert.equal(f.getCreated(),false);
 assert.ok(f.calls.every(x=>x.method==="GET"));
});
test("corromper cópia gera falha de SHA e não declara recuperação",async()=>{
 const f=fixture({corrupt:true});
 await assert.rejects(recoverFullStagingR2({token,accountId,runId,
  fetcher:f.fetcher,exec:f.exec}),/SHA-256/);
});
test("mudança concorrente na origem invalida backup integral",async()=>{
 const f=fixture({sourceChanges:true});
 await assert.rejects(recoverFullStagingR2({token,accountId,runId,
  fetcher:f.fetcher,exec:f.exec}),/alterado/);
});
