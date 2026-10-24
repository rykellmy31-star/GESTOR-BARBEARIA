import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync,writeFileSync } from "node:fs";
import { verifyR2RemoteRestore } from "./staging-r2-remote-restore.mjs";
const accountId="bd72cac5a83927b9fd935b34ad927dc7";
const token="ficticio-token-r2-para-testes-fortes";
const sourceId="12345678-1234-4234-8234-123456789012";
function mock({already=false,failR2=false,calls=[]}={}){
  const host="https://api.cloudflare.com/client/v4/accounts/"+accountId;
  return async(url,opts)=>{
    calls.push({url,method:opts.method,body:opts.body});
    let result;
    if(url===host+"/d1/database?name=tigu-staging-db")result=[{name:"tigu-staging-db",uuid:sourceId}];
    else if(url===host+"/r2/buckets?name_contains=tigu-staging-media")
      result={buckets:[{name:"tigu-staging-media"}]};
    else if(url===host+"/workers/scripts")result=[{id:"tigu-staging"}];
    else if(url===host+"/r2/buckets?name_contains=tigu-staging-restore-check")
      result={buckets:already?[{name:"tigu-staging-restore-check"}]:[]};
    else if(url===host+"/r2/buckets"&&opts.method==="POST"){
      assert.deepEqual(JSON.parse(opts.body),{name:"tigu-staging-restore-check"});
      result={name:"tigu-staging-restore-check"};
    } else throw Error("API fora do escopo R2: "+url);
    if(failR2&&url.includes("restore-check"))return {ok:false,status:403};
    return {ok:true,json:async()=>({success:true,result})};
  };
}
test("bloqueia bucket restore pré-existente, sem escrita em bucket existente",async()=>{
  const calls=[];
  await assert.rejects(verifyR2RemoteRestore({token,accountId,fetcher:mock({already:true,calls})}),
    /já existe/);
  assert.equal(calls.length,4);
  assert.ok(calls.every(c=>c.method==="GET"));
});
test("permissão negada aborta antes do primeiro objeto fictício",async()=>{
  const calls=[];
  await assert.rejects(verifyR2RemoteRestore({token,accountId,fetcher:mock({failR2:true,calls})}),
    /negou acesso/);
  assert.ok(calls.every(c=>c.method==="GET"));
});
test("copia um objeto fictício origem -> recuperação remota e verifica bytes/hash",async()=>{
  const calls=[],remote=new Map(),methods=[];
  const run=(binary,args)=>{
    assert.equal(binary,"npx");
    assert.deepEqual(args.slice(0,3),["wrangler","r2","object"]);
    const op=args[3],target=args[4];
    assert.ok(target.startsWith("tigu-staging-media/__tigu_recovery_test/")||
      target.startsWith("tigu-staging-restore-check/__tigu_recovery_test/"));
    const path=args[args.indexOf("--file")+1];
    assert.ok(args.includes("--remote"));
    methods.push(op);
    if(op==="put")remote.set(target,readFileSync(path));
    else if(op==="get"){
      const bytes=remote.get(target);
      if(!bytes)throw Error("Objeto teste ausente: "+target);
      writeFileSync(path,bytes);
    }else throw Error("Método R2 inesperado.");
  };
  const result=await verifyR2RemoteRestore({token,accountId,
    fetcher:mock({calls}),exec:run});
  assert.deepEqual(methods,["put","get","put","get"]);
  assert.equal(result.cloudflare_r2_restore_verified,true);
  assert.equal(result.all_bucket_objects_copied,false);
  assert.equal(result.originals_unchanged,true);
  assert.equal(result.production_unchanged,true);
  assert.equal(result.objects_verified,1);
  assert.equal(calls.filter(c=>c.method==="POST").length,1);
  assert.ok(!JSON.stringify(result).includes(token));
});
test("corrupção no destino gera falha de checksum",async()=>{
  const remote=new Map();
  await assert.rejects(verifyR2RemoteRestore({
    token,accountId,fetcher:mock(),
    exec:(bin,args)=>{
      const op=args[3],path=args[args.indexOf("--file")+1];
      if(op==="put")remote.set(args[4],readFileSync(path));
      else if(args[4].startsWith("tigu-staging-restore-check/"))
        writeFileSync(path,"CORROMPIDO");
      else writeFileSync(path,remote.get(args[4]));
    },
  }),/SHA-256/);
});
