import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync,readFileSync,writeFileSync,rmSync,existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { inspectStagingInventory, stagingDeploymentPlan, deployTiguStaging } from "./staging-deploy-ci.mjs";

const id="bd72cac5a83927b9fd935b34ad927dc7";
const uuid="12345678-1234-4234-8234-123456789012";
const token="tigu-ficticio-deploy-token-nunca-real";
const d1=[{name:"tigu-staging-db",uuid}];
const r2={buckets:[{name:"tigu-staging-media"}]};
const workers=[];
const template=JSON.parse(readFileSync(new URL("../wrangler.staging.template.jsonc",import.meta.url),"utf8"));
const prod=JSON.parse(readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
test("somente D1/R2 com nomes esperados, UUID correto e Worker ausente permitem deploy",()=>{
  assert.deepEqual(inspectStagingInventory(d1,r2,workers),{
    databaseId:uuid,database:"tigu-staging-db",bucket:"tigu-staging-media",worker:"tigu-staging",
  });
  const config=stagingDeploymentPlan(uuid,template,prod);
  assert.equal(config.name,"tigu-staging");
  assert.equal(config.d1_databases[0].database_id,uuid);
  assert.equal(config.r2_buckets[0].bucket_name,"tigu-staging-media");
  assert.deepEqual(config.triggers.crons,[]);
});
test("bloqueia D1 ausente, UUID ruim, R2 ausente, Worker pré-existente e recursos duplicados",()=>{
  assert.throws(()=>inspectStagingInventory([],r2,workers),/D1/);
  assert.throws(()=>inspectStagingInventory([{name:"tigu-staging-db",uuid:"errado"}],r2,workers),/D1/);
  assert.throws(()=>inspectStagingInventory(d1,{buckets:[]},workers),/R2/);
  assert.throws(()=>inspectStagingInventory(d1,r2,[{id:"tigu-staging"}]),/já existe/);
  assert.throws(()=>inspectStagingInventory(d1.concat(d1),r2,workers),/D1/);
  assert.throws(()=>inspectStagingInventory(d1,{},workers),/inesperado/);
});
test("bloqueia rotas, cron, variável de pagamento e troca de bucket",()=>{
  for(const mutate of [
    c=>{c.routes=[{pattern:"site-real.com/*"}];},
    c=>{c.triggers.crons=["*/1 * * * *"];},
    c=>{c.vars.PAYMENTS_MOCK="1";},
    c=>{c.r2_buckets[0].bucket_name="tigu-media";},
    c=>{c.name="tigu-platform";},
  ]) {
    const bad=structuredClone(template);
    mutate(bad);
    assert.throws(()=>stagingDeploymentPlan(uuid,bad,prod),/bloqueado/);
  }
});
test("orquestração simulada de staging migra, publica somente alvo e gera 2 segredos fortes sem expor valor",async()=>{
  const root=mkdtempSync(join(tmpdir(),"tigu-deploy-ci-"));
  try{
    writeFileSync(join(root,"wrangler.staging.template.jsonc"),JSON.stringify(template));
    writeFileSync(join(root,"wrangler.jsonc"),JSON.stringify(prod));
    const calls=[];
    let deployed=false;
    const fetcher=async (url,options)=>{
      calls.push({http:options.method,url});
      assert.equal(options.method,"GET");
      assert.equal(options.headers.Authorization,"Bearer "+token);
      let result;
      if(url.endsWith("/d1/database?name=tigu-staging-db")) result=d1;
      else if(url.endsWith("/r2/buckets?name_contains=tigu-staging-media")) result=r2;
      else if(url.endsWith("/workers/scripts")) result=deployed?[{id:"tigu-staging"}]:[];
      else throw Error("URL não permitida: "+url);
      return {ok:true,json:async()=>({success:true,result})};
    };
    const run=(cmd,args,options)=>{
      calls.push({cmd,args,input:options.input});
      if(args.includes("prepare")){
        const cfg=stagingDeploymentPlan(uuid,template,prod);
        writeFileSync(join(root,"wrangler.staging.jsonc"),JSON.stringify(cfg));
      }
      if(args.includes("deploy")) deployed=true;
    };
    const result=await deployTiguStaging({token,accountId:id,fetcher,run,root});
    assert.equal(result.staging_deployed,true);
    assert.equal(result.production_modified,false);
    assert.deepEqual(result.secrets_configured,["SESSION_SECRET","MSG_ENC_KEY"]);
    const commandCalls=calls.filter(x=>x.cmd);
    assert.equal(commandCalls.length,6);
    assert.deepEqual(commandCalls.filter(x=>x.cmd==="npx").map(x=>x.args.slice(0,4)),[
      ["wrangler","secret","put","SESSION_SECRET"],
      ["wrangler","secret","put","MSG_ENC_KEY"],
    ]);
    assert.equal(commandCalls.filter(x=>x.args.includes("migrate")).length,1);
    assert.equal(commandCalls.filter(x=>x.args.includes("deploy")).length,1);
    const secretInputs=commandCalls.filter(x=>x.cmd==="npx").map(x=>x.input);
    assert.ok(secretInputs.every(v=>/^[a-f0-9]{96}\n$/.test(v)));
    assert.notEqual(secretInputs[0],secretInputs[1]);
    assert.ok(!JSON.stringify(result).includes(secretInputs[0].trim()));
    assert.ok(!calls.some(x=>["PUT","POST","PATCH","DELETE"].includes(x.http)));
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("sem token ou conta valida nao executa deploy e não gera arquivo",async()=>{
  let calls=0;const fake=()=>{calls++;throw Error("Não deveria consultar Cloudflare.");};
  await assert.rejects(deployTiguStaging({token:"",accountId:id,fetcher:fake}),/TOKEN/);
  await assert.rejects(deployTiguStaging({token,accountId:"não é id",fetcher:fake}),/ACCOUNT_ID/);
  assert.equal(calls,0);
});
