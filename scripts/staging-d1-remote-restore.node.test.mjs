import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync,readdirSync,writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import { newIsolatedRestore,sqlFingerprint,runD1RemoteRecovery } from "./staging-d1-remote-restore.mjs";

const accountId="bd72cac5a83927b9fd935b34ad927dc7";
const token="tigu-ficticio-token-para-teste-remoto";
const source="12345678-1234-4234-8234-123456789012";
const target="87654321-4321-4321-8321-210987654321";
const root=resolve(import.meta.dirname,"..");
const sql=readdirSync(join(root,"migrations")).filter(x=>/^\d{4}_.*\.sql$/.test(x)).sort()
  .map(x=>readFileSync(join(root,"migrations",x),"utf8")).join("\n");
function fake({targetExists=false,deny=false,calls=[]}={}) {
  return async (url,opts)=>{
    const path=url.replace("https://api.cloudflare.com/client/v4","");
    calls.push({path,method:opts.method,body:opts.body});
    if(deny)return {ok:false,status:403};
    let result;
    if(path.endsWith("/d1/database?name=tigu-staging-db"))result=[{uuid:source,name:"tigu-staging-db"}];
    else if(path.endsWith("/r2/buckets?name_contains=tigu-staging-media"))
      result={buckets:[{name:"tigu-staging-media"}]};
    else if(path.endsWith("/workers/scripts"))result=[{id:"tigu-staging"}];
    else if(path.endsWith("/d1/database?name=tigu-staging-restore-check"))
      result=targetExists?[{uuid:target,name:"tigu-staging-restore-check"}]:[];
    else if(path.endsWith("/d1/database")&&opts.method==="POST") {
      assert.deepEqual(JSON.parse(opts.body),{name:"tigu-staging-restore-check"});
      result={uuid:target,name:"tigu-staging-restore-check"};
    }else throw Error("API de produção não deve ser chamada: "+path);
    return {ok:true,json:async()=>({success:true,result})};
  };
}
test("fingerprint compara registros, não somente contagem de tabelas",()=>{
  const initial=sql+"\nINSERT INTO companies(id,slug,name) VALUES (500,'teste','Empresa Fictícia');\n";
  const altered=sql+"\nINSERT INTO companies(id,slug,name) VALUES (500,'teste','Empresa ALTERADA');\n";
  assert.match(sqlFingerprint(initial).sha256,/^[a-f0-9]{64}$/);
  assert.notEqual(sqlFingerprint(initial).sha256,sqlFingerprint(altered).sha256);
});
test("restauração nunca sobrescreve D1 já existente e nunca usa UUID da origem",async()=>{
  const calls=[];
  await assert.rejects(newIsolatedRestore({
    token,accountId,sourceId:source,fetcher:fake({targetExists:true,calls}),
  }),/já existe/);
  assert.equal(calls.length,1);
  assert.ok(calls.every(x=>x.method==="GET"));
  const sourceAsTarget=async(url,opts)=>({
    ok:true,json:async()=>({success:true,result:opts.method==="POST"?
      {name:"tigu-staging-restore-check",uuid:source}:[]}),
  });
  await assert.rejects(newIsolatedRestore({
    token,accountId,sourceId:source,fetcher:sourceAsTarget,
  }),/incompatível/);
});
test("import/export usam SOMENTE banco restore com UUID diferente, nada registrado no Git",async()=>{
  const calls=[],cli=[];
  const execute=(cmd,args,opts)=>{
    assert.equal(cmd,"npx");
    assert.deepEqual(args.slice(0,2),["wrangler","d1"]);
    cli.push(args);
    const name=args[3];
    const config=JSON.parse(readFileSync(args[args.indexOf("--config")+1],"utf8"));
    if(args[2]==="execute"){
      assert.equal(name,"tigu-staging-restore-check");
      assert.equal(config.d1_databases[0].database_id,target);
      assert.equal(config.d1_databases[0].database_name,"tigu-staging-restore-check");
      assert.ok(args.includes("--file"));
      return;
    }
    assert.equal(args[2],"export");
    if(name==="tigu-staging-db")
      assert.equal(config.d1_databases[0].database_id,source);
    else if(name==="tigu-staging-restore-check")
      assert.equal(config.d1_databases[0].database_id,target);
    else throw Error("Banco inesperado: "+name);
    writeFileSync(args[args.indexOf("--output")+1],sql);
  };
  const result=await runD1RemoteRecovery({
    token,accountId,root,execute,fetcher:fake({calls}),
  });
  assert.equal(result.cloudflare_restore_verified,true);
  assert.equal(result.checksums_match,true);
  assert.equal(result.dumps_deleted,true);
  assert.equal(result.production_unchanged,true);
  assert.deepEqual(cli.map(x=>x[2]),["export","execute","export"]);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(accountId));
  assert.equal(calls.filter(x=>x.method==="POST").length,1);
});
test("SQL inválido não cria D1 restore",async()=>{
  const calls=[];
  await assert.rejects(runD1RemoteRecovery({
    token,accountId,root,fetcher:fake({calls}),
    execute:(cmd,args)=>writeFileSync(args[args.indexOf("--output")+1],"INVALID SQL"),
  }),/muito curta|syntax/i);
  assert.ok(calls.every(x=>x.method==="GET"));
});
