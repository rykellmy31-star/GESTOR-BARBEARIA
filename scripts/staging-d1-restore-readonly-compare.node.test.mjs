import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync,readdirSync,writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import { compareExistingStagingD1 } from "./staging-d1-restore-readonly-compare.mjs";

const token="token-de-homologacao-ficticio-suficientemente-longo";
const accountId="bd72cac5a83927b9fd935b34ad927dc7";
const sourceId="12345678-1234-4234-8234-123456789012";
const targetId="92345678-1234-4234-8234-123456789012";
const root=resolve(import.meta.dirname,"..");
const sql=readdirSync(join(root,"migrations")).filter(n=>/^\d{4}_.*\.sql$/.test(n)).sort()
 .map(n=>readFileSync(join(root,"migrations",n),"utf8")).join("\n");
function fake({exists=true,unauthorized=false,requests=[]}={}){
 const host="https://api.cloudflare.com/client/v4/accounts/"+accountId;
 return async(url,opt)=>{
  requests.push({url,method:opt.method,auth:opt.headers?.Authorization});
  assert.equal(opt.method,"GET");
  assert.equal(opt.headers.Authorization,"Bearer "+token);
  if(unauthorized)return {ok:false,status:403};
  let result;
  if(url===host+"/d1/database?name=tigu-staging-db")
   result=[{uuid:sourceId,name:"tigu-staging-db"}];
  else if(url===host+"/r2/buckets?name_contains=tigu-staging-media")
   result={buckets:[{name:"tigu-staging-media"}]};
  else if(url===host+"/workers/scripts")result=[{id:"tigu-staging"}];
  else if(url===host+"/d1/database?name=tigu-staging-restore-check")
   result=exists?[{uuid:targetId,name:"tigu-staging-restore-check"}]:[];
  else throw Error("Cloudflare GET inesperado: "+url);
  return {ok:true,json:async()=>({success:true,result})};
 };
}
function runner({calls=[],mismatch=false,corruptTarget=false}={}){
 return (binary,args)=>{
  assert.equal(binary,"npx");
  assert.deepEqual(args.slice(0,4),["wrangler","d1","export",args[3]]);
  assert.ok(args.includes("--remote"));
  assert.ok(!args.includes("execute")&&!args.includes("deploy")&&!args.includes("migrations"));
  const db=args[3];
  assert.ok(db==="tigu-staging-db"||db==="tigu-staging-restore-check");
  const config=JSON.parse(readFileSync(args[args.indexOf("--config")+1],"utf8"));
  assert.equal(config.d1_databases[0].database_id,
    db==="tigu-staging-db"?sourceId:targetId);
  calls.push({db,mode:"export"});
  writeFileSync(args[args.indexOf("--output")+1],db==="tigu-staging-restore-check"?
    corruptTarget?"invalid SQL for intentionally failing read-only check":
    mismatch?sql+"\nCREATE TABLE backup_diff(id INTEGER PRIMARY KEY);\n":sql:sql);
 };
}
test("comparação com cópia idêntica aprova somente GET e dois exports",async()=>{
 const requests=[],calls=[];
 const result=await compareExistingStagingD1({
  token,accountId,fetcher:fake({requests}),exec:runner({calls}),root
 });
 assert.equal(result.cloudflare_restore_verified,true);
 assert.equal(result.fingerprints_match,true);
 assert.equal(result.remote_writes,0);
 assert.equal(result.production_modified,false);
 assert.equal(requests.length,4);
 assert.ok(requests.every(x=>x.method==="GET"));
 assert.deepEqual(calls.map(c=>c.db),["tigu-staging-db","tigu-staging-restore-check"]);
 assert.ok(!JSON.stringify(result).includes(token));
 assert.ok(!JSON.stringify(result).includes(accountId));
});
test("cópia D1 diferente não é homologada e não gera escrita",async()=>{
 const result=await compareExistingStagingD1({
  token,accountId,fetcher:fake(),exec:runner({mismatch:true}),root
 });
 assert.equal(result.cloudflare_restore_verified,false);
 assert.equal(result.remote_writes,0);
 assert.match(result.reason,/difere/);
});
test("cópia incompleta/corrompida não é declarada recuperada",async()=>{
 const result=await compareExistingStagingD1({
  token,accountId,fetcher:fake(),exec:runner({corruptTarget:true}),root
 });
 assert.equal(result.cloudflare_restore_verified,false);
 assert.equal(result.destination_checkout_schema_complete,false);
});
test("destino ausente recusa export e qualquer mutação",async()=>{
 const calls=[],requests=[];
 await assert.rejects(compareExistingStagingD1({
  token,accountId,fetcher:fake({exists:false,requests}),exec:runner({calls}),root
 }),/ausente/);
 assert.equal(calls.length,0);
 assert.ok(requests.every(r=>r.method==="GET"));
});
test("Cloudflare negou leitura: falha sem exportação",async()=>{
 const calls=[];
 await assert.rejects(compareExistingStagingD1({
  token,accountId,fetcher:fake({unauthorized:true}),exec:runner({calls}),root
 }),/negou|não permitiu/);
 assert.equal(calls.length,0);
});
