import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync,mkdtempSync,writeFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {spawnSync} from "node:child_process";
import {productionConfigIssues,inspectProductionConfig} from "./production-preflight.mjs";

const current=JSON.parse(readFileSync(new URL("../wrangler.jsonc",import.meta.url),"utf8"));
const good=()=>({...structuredClone(current),vars:{APP_ENV:"production",GRAPH_API_VERSION:"v23.0"},
  name:"tigu-production",
  d1_databases:[{binding:"DB",database_name:"tigu-production-db",database_id:"12345678-1234-4234-9234-123456789012",migrations_dir:"migrations"}],
  r2_buckets:[{binding:"MEDIA",bucket_name:"tigu-production-media"}]});

test("a configuracao publica atual de desenvolvimento impede deploy remoto",()=>{
  assert.ok(productionConfigIssues(current).some(e=>e.includes("APP_ENV")));
  assert.ok(productionConfigIssues(current).some(e=>e.includes("D1")));
});
test("configuracao de producao valida aprova o preflight local",()=>{
  assert.deepEqual(productionConfigIssues(good()),[]);
});
test("mocks e marcador staging nunca passam",()=>{
  for(const k of ["PAYMENTS_MOCK","WHATSAPP_MOCK","TIGU_STAGING"]){
    for(const v of ["1",1,true,"yes","on"]){
      const c=good();c.vars[k]=v;
      assert.ok(productionConfigIssues(c).length, k+"="+v);
    }
  }
});
test("credenciais em vars publicas sao bloqueadas",()=>{
  for(const k of ["SESSION_SECRET","MSG_ENC_KEY","MERCADOPAGO_ACCESS_TOKEN","WHATSAPP_APP_SECRET_FOR_OAUTH"]){
    const c=good();c.vars[k]="NAO_PUBLICAR";
    assert.ok(productionConfigIssues(c).some(e=>e.includes("Credenciais")),k);
  }
});
test("bloqueia D1, R2, cron, rotas e ambiente malformados",()=>{
  for(const fn of [
    c=>{c.name="tigu-staging"},
    c=>{c.d1_databases[0].database_id="REPLACE_WITH_ID"},
    c=>{c.d1_databases=[]},
    c=>{c.r2_buckets=[]},
    c=>{c.assets.run_worker_first=["/api/*"]},
    c=>{c.triggers.crons=[]}
  ]){const c=good();fn(c);assert.ok(productionConfigIssues(c).length)}
  assert.ok(productionConfigIssues(null).length);
});
test("CLI bloqueia de forma local sem alterar arquivo nem acessar rede",()=>{
  const dir=mkdtempSync(join(tmpdir(),"tigu-preflight-"));
  try{
    const config=JSON.stringify(current);
    writeFileSync(join(dir,"wrangler.jsonc"),config);
    const p=new URL("./production-preflight.mjs",import.meta.url);
    const bad=spawnSync(process.execPath,[p.pathname],{cwd:dir,encoding:"utf8"});
    assert.equal(bad.status,1);
    assert.match(bad.stderr,/BLOQUEADO/);
    assert.equal(readFileSync(join(dir,"wrangler.jsonc"),"utf8"),config);
    writeFileSync(join(dir,"wrangler.jsonc"),JSON.stringify(good()));
    const ok=spawnSync(process.execPath,[p.pathname],{cwd:dir,encoding:"utf8"});
    assert.equal(ok.status,0,ok.stderr);
  }finally{rmSync(dir,{recursive:true,force:true})}
});
test("npm proibe deploy e migracao remota antes do gate",()=>{
  const p=JSON.parse(readFileSync(new URL("../package.json",import.meta.url),"utf8"));
  assert.match(p.scripts.deploy,/^node scripts\/production-preflight\.mjs && npm run build && wrangler deploy$/);
  assert.match(p.scripts["db:migrate:remote"],/^node scripts\/production-preflight\.mjs && wrangler d1 migrations apply tigu-db --remote$/);
});
