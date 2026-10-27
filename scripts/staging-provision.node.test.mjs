import test from "node:test";
import assert from "node:assert/strict";
import { provisionTiguStaging } from "./staging-provision.mjs";

const id = "bd72cac5a83927b9fd935b34ad927dc7";
const token = "tigu-staging-token-de-teste-nunca-real";
const uuid = "12345678-1234-4234-8234-123456789012";
const prefix = "/accounts/" + id;
function fake({ startD1 = false, startR2 = false, startWorker = false, denied = "", malformed = false } = {}) {
  const calls = [];
  let d1 = startD1, r2 = startR2;
  async function fetcher(url, options) {
    const path = url.replace("https://api.cloudflare.com/client/v4","");
    calls.push({ path, method: options.method, options });
    assert.equal(options.headers.Authorization, "Bearer " + token);
    assert.equal(options.redirect, "error");
    if (denied === path) return { ok:false,status:403 };
    const output = () => {
      if (path === "/user/tokens/verify") return { status:"active" };
      if (path === prefix + "/d1/database?name=tigu-staging-db") return d1 ? [{ name:"tigu-staging-db", uuid }] : [];
      if (path === prefix + "/r2/buckets?name_contains=tigu-staging-media")
        return { buckets: r2 ? [{ name:"tigu-staging-media" }] : [] };
      if (path === prefix + "/workers/scripts") return startWorker ? [{ id:"tigu-staging" }] : [];
      if (options.method === "POST" && path === prefix + "/d1/database") {
        assert.deepEqual(JSON.parse(options.body),{name:"tigu-staging-db"});
        d1 = true;
        return { name:"tigu-staging-db", uuid };
      }
      if (options.method === "POST" && path === prefix + "/r2/buckets") {
        assert.deepEqual(JSON.parse(options.body),{name:"tigu-staging-media"});
        r2 = true;
        return { name:"tigu-staging-media" };
      }
      throw Error("Operação inesperada: " + path);
    };
    return { ok:true,status:200,json:async()=>({success:true,result:malformed ? {} : output()}) };
  }
  return { fetcher,calls };
}

test("diagnóstico de token usa exclusivamente GET e não expõe IDs nem credenciais",async()=>{
  const {fetcher,calls}=fake();
  const result=await provisionTiguStaging({token,accountId:id,fetcher});
  assert.equal(calls.length,4);
  assert.ok(calls.every(c=>c.method==="GET"));
  assert.deepEqual(result.staging,{d1:false,r2:false,worker:false});
  assert.equal(result.existing_resources_modified,false);
  assert.equal(result.production_resources_modified,false);
  assert.ok(!JSON.stringify(result).includes(token));
  assert.ok(!JSON.stringify(result).includes(id));
  assert.ok(!JSON.stringify(result).includes(uuid));
});
test("criação limitada a dois POST com nomes fixos e sem Worker, migrações ou remoção",async()=>{
  const {fetcher,calls}=fake();
  const result=await provisionTiguStaging({token,accountId:id,fetcher,create:true});
  assert.deepEqual(result.staging,{d1:true,r2:true,worker:false});
  assert.deepEqual(result.created,{d1:true,r2:true});
  const posts=calls.filter(c=>c.method==="POST");
  assert.equal(posts.length,2);
  assert.deepEqual(posts.map(x=>x.path),[prefix+"/d1/database",prefix+"/r2/buckets"]);
  assert.ok(!calls.some(x=>["PUT","PATCH","DELETE"].includes(x.method)));
  assert.equal(result.staging_worker_deployed,false);
  assert.equal(result.backups_restored,false);
});
test("repetição não altera recursos de homologação já existentes",async()=>{
  const {fetcher,calls}=fake({startD1:true,startR2:true,startWorker:true});
  const result=await provisionTiguStaging({token,accountId:id,fetcher,create:true});
  assert.equal(calls.length,7);
  assert.ok(calls.every(c=>c.method==="GET"));
  assert.deepEqual(result.created,{d1:false,r2:false});
  assert.deepEqual(result.staging,{d1:true,r2:true,worker:true});
});
test("se existe D1, cria só R2 sem modificar D1",async()=>{
  const {fetcher,calls}=fake({startD1:true});
  const result=await provisionTiguStaging({token,accountId:id,fetcher,create:true});
  assert.deepEqual(result.created,{d1:false,r2:true});
  assert.deepEqual(calls.filter(x=>x.method==="POST").map(x=>x.path),[prefix+"/r2/buckets"]);
});
test("falha antes de qualquer chamada sem credenciais; não força permissões ausentes",async()=>{
  const {fetcher,calls}=fake();
  await assert.rejects(provisionTiguStaging({token:"",accountId:id,fetcher,create:true}),/CLOUDFLARE_STAGING_TOKEN/);
  await assert.rejects(provisionTiguStaging({token,accountId:"abc",fetcher,create:true}),/CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(calls.length,0);
  const forbidden=fake({denied:prefix+"/r2/buckets?name_contains=tigu-staging-media"});
  await assert.rejects(provisionTiguStaging({token,accountId:id,fetcher:forbidden.fetcher,create:true}),/rejeitou operação de leitura \(403\)/);
  assert.ok(forbidden.calls.every(c=>c.method==="GET"));
});
test("formato de inventário incorreto impede qualquer escrita",async()=>{
  const {fetcher,calls}=fake({malformed:true});
  await assert.rejects(provisionTiguStaging({token,accountId:id,fetcher,create:true}),/não está ativo|inesperado/);
  assert.ok(calls.every(x=>x.method==="GET"));
});
