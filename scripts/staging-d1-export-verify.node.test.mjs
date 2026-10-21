import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync,readdirSync,mkdtempSync,writeFileSync,rmSync,existsSync } from "node:fs";
import { join,resolve } from "node:path";
import { tmpdir } from "node:os";
import { inspectExportTarget,exportAndCheckStaging } from "./staging-d1-export-verify.mjs";

const token="token-de-staging-ficticio-validacao-export";
const id="bd72cac5a83927b9fd935b34ad927dc7";
const uuid="12345678-1234-4234-8234-123456789012";
const root=resolve(import.meta.dirname,"..");
const sql=readdirSync(join(root,"migrations")).filter(x=>/^\d{4}_.*\.sql$/.test(x)).sort()
  .map(x=>readFileSync(join(root,"migrations",x),"utf8")).join("\n");
function client({missing=false,unauthorized=false,requests=[]}={}){
  return async (url,opts)=>{
    requests.push({url,opts});
    assert.equal(opts.method,"GET");
    assert.equal(opts.headers.Authorization,"Bearer "+token);
    if(unauthorized) return {ok:false,status:403};
    let result;
    if(url.endsWith("/d1/database?name=tigu-staging-db"))
      result=missing?[]:[{uuid,name:"tigu-staging-db"}];
    else if(url.endsWith("/r2/buckets?name_contains=tigu-staging-media"))
      result={buckets:missing?[]:[{name:"tigu-staging-media"}]};
    else if(url.endsWith("/workers/scripts"))
      result=missing?[]:[{id:"tigu-staging"}];
    else throw Error("Solicitação não autorizada pelo teste: "+url);
    return {ok:true,json:async()=>({success:true,result})};
  };
}
test("exportador recusa token inválido ou recursos incompletos ANTES de exportar",async()=>{
  const requests=[];
  await assert.rejects(inspectExportTarget({token:"",accountId:id,fetcher:client({requests})}),/TOKEN/);
  await assert.rejects(inspectExportTarget({token,accountId:"ID",fetcher:client({requests})}),/ACCOUNT_ID/);
  assert.equal(requests.length,0);
  await assert.rejects(inspectExportTarget({token,accountId:id,fetcher:client({missing:true})}),/incompleto/);
  await assert.rejects(inspectExportTarget({token,accountId:id,fetcher:client({unauthorized:true})}),/não permitiu/);
});
test("evidência usa somente GET API + wrangler d1 export --remote sem importar nem expor SQL",async()=>{
  const calls=[],requests=[];
  const temp=mkdtempSync(join(tmpdir(),"tigu-d1-test-"));
  try{
    const exec=(bin,args,opts)=>{
      calls.push({bin,args,opts});
      assert.equal(bin,"npx");
      assert.deepEqual(args.slice(0,4),["wrangler","d1","export","tigu-staging-db"]);
      assert.ok(args.includes("--remote"));
      assert.ok(args.includes("--output"));
      assert.ok(!args.includes("execute")&&!args.includes("import")&&!args.includes("deploy"));
      assert.equal(opts.env.CLOUDFLARE_API_TOKEN,token);
      assert.equal(opts.env.CLOUDFLARE_ACCOUNT_ID,id);
      const config=JSON.parse(readFileSync(args[args.indexOf("--config")+1],"utf8"));
      assert.equal(config.name,"tigu-staging");
      assert.equal(config.d1_databases[0].database_id,uuid);
      assert.equal(config.r2_buckets[0].bucket_name,"tigu-staging-media");
      writeFileSync(args[args.indexOf("--output")+1],sql);
    };
    const value=await exportAndCheckStaging({token,accountId:id,fetcher:client({requests}),exec,root});
    assert.equal(value.source,"cloudflare-d1-staging");
    assert.equal(value.sql_exported,true);
    assert.equal(value.local_sqlite_restore_verified,true);
    assert.equal(value.cloudflare_restore_verified,false);
    assert.equal(value.r2_backup_verified,false);
    assert.equal(value.essential_tables,19);
    assert.equal(value.dump_persisted,false);
    assert.equal(calls.length,1);
    assert.equal(requests.length,3);
    assert.ok(!JSON.stringify(value).includes(token));
    assert.ok(!JSON.stringify(value).includes(id));
    assert.ok(!JSON.stringify(value).includes(sql.slice(100,180)));
  }finally{rmSync(temp,{force:true,recursive:true});}
});
test("exportação corrompida é rejeitada e nunca gera sucesso fictício",async()=>{
  let once=0;
  const exec=(bin,args)=>{once++;writeFileSync(args[args.indexOf("--output")+1],"not a sqlite export");};
  await assert.rejects(exportAndCheckStaging({token,accountId:id,fetcher:client(),exec,root}),/muito curta|syntax|erro|near/i);
  assert.equal(once,1);
});
test("falha do wrangler não é tratada como validação de backup",async()=>{
  await assert.rejects(exportAndCheckStaging({
    token,accountId:id,fetcher:client(),root,
    exec:()=>{throw Error("Test fixture CLI failure, NO TOKENS");},
  }),/Exportação D1 Cloudflare falhou/);
});
