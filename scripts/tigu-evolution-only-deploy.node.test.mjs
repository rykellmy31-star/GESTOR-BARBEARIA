import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,readdirSync} from "node:fs";
import {resolve} from "node:path";
import {checkInventory} from "./tigu-evolution-only-deploy.mjs";

const uuid="78228a5b-4e4c-4710-b89c-664ef15f8da3";
const names=readdirSync(resolve(import.meta.dirname,"../migrations"))
 .filter(n=>/^\d+.*\.sql$/.test(n)).sort();
const t={dbs:[{name:"tigu-staging-db",uuid}],
 buckets:{buckets:[{name:"tigu-staging-media"}]},
 workers:[{id:"tigu-staging"}],
 domains:[{hostname:"agendamentos.crjornada.com",service:"tigu-staging",enabled:true}],
 settings:{bindings:[
  {type:"d1",name:"DB",id:uuid},
  {type:"r2_bucket",name:"MEDIA",bucket_name:"tigu-staging-media"},
  {type:"secret_text",name:"SESSION_SECRET"},
  {type:"secret_text",name:"MSG_ENC_KEY"},
  {type:"plain_text",name:"APP_ENV",text:"production"},
  {type:"plain_text",name:"TIGU_STAGING",text:"1"},
  {type:"plain_text",name:"WHATSAPP_MOCK",text:"1"},
  {type:"plain_text",name:"PAYMENTS_MOCK",text:"0"},
 ]},
 migrations:names,expected:names,
};
test("somente versão Evolution após todas as migrations pode fazer deploy de código",()=>{
 assert.equal(names.length,27);
 const r=checkInventory(t);
 assert.equal(r.dbId,uuid);
 assert.equal(r.secrets.includes("SESSION_SECRET"),true);
 assert.equal(r.originalBindings.length,8);
});
test("falha antes de deploy se D1, Worker, R2, rota ou segredo mudar",()=>{
 for(const [key,value] of [
  ["dbs",[]],["buckets",{buckets:[]}],["workers",[]],
  ["domains",[{hostname:"agendamentos.crjornada.com",service:"tigu-outro",enabled:true}]],
  ["settings",{bindings:t.settings.bindings.filter(x=>x.name!=="MSG_ENC_KEY")}],
 ]){
  assert.throws(()=>checkInventory({...t,[key]:value}));
 }
});
test("falha se Evolution 0104 estiver pendente, ou se histórico for alterado",()=>{
 assert.throws(()=>checkInventory({...t,migrations:names.slice(0,-1)}));
 assert.throws(()=>checkInventory({...t,migrations:[...names.slice(0,-1),"9999_unknown.sql"]}));
});
test("script remoto não cria recursos, não migra SQL e preserva bindings",()=>{
 const code=readFileSync(resolve(import.meta.dirname,"tigu-evolution-only-deploy.mjs"),"utf8");
 assert.match(code,/\[cli,"deploy","--keep-vars","--config",path\]/);
 assert.doesNotMatch(code,/exec\([^\n]+migrations.*apply/);
 assert.match(code,/exportAndCheckStaging/);
 assert.match(code,/staging_preserved:true/);
 assert.match(code,/TIGU_EVOLUTION_LIVE:"1"/);
 assert.match(code,/template\.triggers\.crons=\["\* \* \* \* \*"\]/);
 assert.match(code,/EVOLUTION_API_URL:"https:\/\/evolution\.crjornada\.com"/);
});
