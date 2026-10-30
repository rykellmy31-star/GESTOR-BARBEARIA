import test from "node:test";
import assert from "node:assert/strict";
import {readdirSync} from "node:fs";
import {resolve} from "node:path";
import {TARGET,inspectOfficialInventory} from "./tigu-official-release-once.mjs";
const UUID="78228a5b-4e4c-4710-b89c-664ef15f8da3";
const expected=readdirSync(resolve(import.meta.dirname,"../migrations"))
  .filter(x=>/^\d+.*\.sql$/.test(x)).sort();
const existing=expected.slice(0,-6);
const settings={bindings:[
  {type:"d1",name:"DB",id:UUID},
  {type:"r2_bucket",name:"MEDIA",bucket_name:TARGET.bucket},
  {type:"secret_text",name:"SESSION_SECRET"},
  {type:"secret_text",name:"MSG_ENC_KEY"},
  {type:"secret_text",name:"MP_ACCESS_TOKEN"},
  {type:"plain_text",name:"APP_ENV",text:"production"},
  {type:"plain_text",name:"TIGU_STAGING",text:"1"},
  {type:"plain_text",name:"WHATSAPP_MOCK",text:"1"},
  {type:"plain_text",name:"PAYMENTS_MOCK",text:"0"},
]};
const good=[
  [{name:TARGET.database,uuid:UUID}],
  {buckets:[{name:TARGET.bucket}]},
  [{id:TARGET.worker}],
  [{hostname:TARGET.hostname,service:TARGET.worker,enabled:true}],
  settings,existing,expected
];
test("liberar somente as seis migrações aditivas pendentes no banco existente",()=>{
  assert.equal(expected.length,26);
  const r=inspectOfficialInventory(...good);
  assert.deepEqual(r.pendingMigrations,expected.slice(20));
  assert.equal(r.appliedMigrationCount,20);
  assert.equal(r.existingSecretNames.includes("MP_ACCESS_TOKEN"),true);
});
test("recusar troca de domínio, banco, bucket e Worker",()=>{
  for(const [index,value] of [
    [0,[{name:TARGET.database,uuid:"invalid"}]],
    [1,{buckets:[{name:"other"}]}],
    [2,[{id:"tigu-other"}]],
    [3,[{hostname:TARGET.hostname,service:"tigu-production",enabled:true}]],
    [3,[{hostname:TARGET.hostname,service:TARGET.worker,enabled:false}]],
  ]){const v=[...good];v[index]=value;assert.throws(()=>inspectOfficialInventory(...v));}
});
test("recusar segredos não comprovados e bindings inesperados",()=>{
  const noSecrets={bindings:settings.bindings.filter(x=>x.name!=="SESSION_SECRET")};
  const additional={bindings:[...settings.bindings,{name:"SPECIAL",type:"service"}]};
  for(const s of [noSecrets,additional]){const v=[...good];v[4]=s;assert.throws(()=>inspectOfficialInventory(...v));}
});
test("recusar quando o banco tem migrações diferentes",()=>{
  for(const h of [existing.slice(0,-1),[...existing,expected.at(-1)],[...existing,"unknown.sql"]]){
    const v=[...good];v[5]=h;assert.throws(()=>inspectOfficialInventory(...v));
  }
});
