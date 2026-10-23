import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
import {updateStagingWorker} from "./staging-update-ci.mjs";
const token="ficticio-secret-staging-ci-example",accountId="1234567890abcdef1234567890abcdef";
const uuid="12345678-1234-4234-8234-123456789012";
const root=resolve(import.meta.dirname,"..");
const [template,production]=["wrangler.staging.template.jsonc","wrangler.jsonc"].map(n=>readFileSync(join(root,n),"utf8"));
function mock({worker=true,d1=true,r2=true,healthy=true,credentials=false,requests=[]}={}){
 return async (url,opts)=>{
  requests.push({url,method:opts.method});
  assert.equal(opts.method,"GET");
  let result;
  if(url.endsWith("/d1/database?name=tigu-staging-db"))result=d1?[{name:"tigu-staging-db",uuid}]:[];
  else if(url.endsWith("/r2/buckets?name_contains=tigu-staging-media"))
    result={buckets:r2?[{name:"tigu-staging-media"}]:[]};
  else if(url.endsWith("/workers/scripts"))result=worker?[{id:"tigu-staging"}]:[];
  else if(url.endsWith("/api/health"))
    return {status:200,json:async()=>({staging:healthy,d1:true,r2:true,
      security:{session_secret_ready:true,encryption_key_ready:true},
      payments:{mercadopago:credentials,mock:false},whatsapp:{embedded:credentials,mock:true}})};
  else throw Error("URL inesperada: "+url);
  return {ok:true,json:async()=>({success:true,result})};
 };
}
test("redeploy é negado antes de escrita quando D1, R2 ou Worker está ausente",async()=>{
 for(const absent of ["worker","d1","r2"]){
   let count=0;
   await assert.rejects(updateStagingWorker({
    token,accountId,root,fetcher:mock({[absent]:false}),
    exec:()=>{count++},
   }),/ausente ou ambíguo/);
   assert.equal(count,0);
 }
});
test("redeploy conserva segredos, valida configuração, faz apenas build/deploy sem migrações",async()=>{
 const tmp=mkdtempSync(join(tmpdir(),"tigu-redeploy-test-"));
 try {
  writeFileSync(join(tmp,"wrangler.staging.template.jsonc"),template);
  writeFileSync(join(tmp,"wrangler.jsonc"),production);
  const commands=[],requests=[];
  const exec=(cmd,args)=>{
    commands.push([cmd,...args]);
    if(args.includes("prepare")){
      const cfg=JSON.parse(template);
      cfg.d1_databases[0].database_id=uuid;
      writeFileSync(join(tmp,"wrangler.staging.jsonc"),JSON.stringify(cfg));
    }
  };
  const result=await updateStagingWorker({token,accountId,root:tmp,
    fetcher:mock({requests}),exec});
  assert.equal(result.code_updated,true);
  assert.equal(result.existing_secrets_preserved,true);
  assert.equal(result.production_modified,false);
  assert.equal(commands.length,3);
  assert.deepEqual(commands.map(args=>args[2]),["prepare","validate","deploy"]);
  assert.ok(!commands.some(args=>args.includes("migrate")||args.includes("secret")||args.includes("put")));
  assert.equal(requests.length,4);
 }finally{rmSync(tmp,{force:true,recursive:true});}
});
test("staging com tokens dos provedores não libera transações e continua publicável",async()=>{
 const tmp=mkdtempSync(join(tmpdir(),"tigu-redeploy-credentials-"));
 try {
  writeFileSync(join(tmp,"wrangler.staging.template.jsonc"),template);
  writeFileSync(join(tmp,"wrangler.jsonc"),production);
  const exec=(bin,args)=>{
   if(args.includes("prepare")){
    const cfg=JSON.parse(template);cfg.d1_databases[0].database_id=uuid;
    writeFileSync(join(tmp,"wrangler.staging.jsonc"),JSON.stringify(cfg));
   }
  };
  const result=await updateStagingWorker({
   token,accountId,root:tmp,fetcher:mock({credentials:true}),exec
  });
  assert.equal(result.staging_health_verified,true);
  assert.equal(result.real_providers_enabled,false);
  assert.equal(result.production_modified,false);
 } finally { rmSync(tmp,{force:true,recursive:true}); }
});

test("falha com health sem chaves configuradas, nunca anuncia sucesso",async()=>{
 const tmp=mkdtempSync(join(tmpdir(),"tigu-redeploy-check-"));
 try{
  writeFileSync(join(tmp,"wrangler.staging.template.jsonc"),template);
  writeFileSync(join(tmp,"wrangler.jsonc"),production);
  const exec=(bin,args)=>{
    if(args.includes("prepare")){
      const cfg=JSON.parse(template);cfg.d1_databases[0].database_id=uuid;
      writeFileSync(join(tmp,"wrangler.staging.jsonc"),JSON.stringify(cfg));
    }
  };
  await assert.rejects(updateStagingWorker({
    token,accountId,root:tmp,fetcher:mock({healthy:false}),exec,
  }),/Health staging/);
 }finally{rmSync(tmp,{force:true,recursive:true});}
});
