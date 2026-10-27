import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const validation=stripTypeScriptTypes(read('api/lib/platform-setting-validation.ts'),{mode:'strip'});
const settings=stripTypeScriptTypes(read('api/lib/settings.ts').split('export const platformDefaults =')[1] ? 'export const platformDefaults ='+read('api/lib/settings.ts').split('export const platformDefaults =')[1] : '',{mode:'strip'});
const {isValidPlatformSetting,setPlatformSetting,loadPlatformSettings}=await import('data:text/javascript;base64,'+Buffer.from(validation+'\n'+settings).toString('base64'));
const route=read('api/routes/super.ts');
function fixture(){
  const sql=new DatabaseSync(':memory:');
  sql.exec('CREATE TABLE platform_settings(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated_at TEXT NOT NULL)');
  return {
    sql,
    db:{prepare(query){return{
      all:async()=>({results:sql.prepare(query).all()}),
      bind(...args){const params=Object.fromEntries(args.map((v,i)=>[String(i+1),v]));return{run:async()=>{const r=sql.prepare(query).run(params);return{success:true,meta:{changes:Number(r.changes)}};}};}
    };}},
    value:key=>sql.prepare('SELECT value FROM platform_settings WHERE key=?').get(key)?.value,
    close:()=>sql.close()
  };
}

test('preços, intervalos e campos financeiros aceitam apenas inteiros seguros',()=>{
  for(const [key,value] of [
    ['topup_min_cents','200'],['topup_max_cents',0],['topup_max_cents',-1],
    ['msg_max_attempts',0],['msg_max_attempts',11],['retry_backoff_sec',0],
    ['reminder_lead_min',1441],['capture_on','unknown'],['capture_on',2],
    ['msg_cost_cents',NaN],['msg_price_cents',Infinity],['msg_price_cents',1.5],
    ['other_key',100],['topup_max_cents',Number.MAX_SAFE_INTEGER]
  ]) assert.equal(isValidPlatformSetting(key,value),false,key+'='+value);
  for(const [key,value] of [['capture_on','sent'],['capture_on','delivered'],['topup_min_cents',1],['msg_price_cents',0],['msg_max_attempts',10],['topup_max_cents',100000000]])
    assert.equal(isValidPlatformSetting(key,value),true,key+'='+value);
});
test('limite mínimo nunca ultrapassa máximo, mesmo em atualizações sucessivas',async()=>{
  const f=fixture();
  try{
    assert.equal(await setPlatformSetting(f.db,'topup_min_cents',500001),false);
    assert.equal(await setPlatformSetting(f.db,'topup_max_cents',999),false);
    assert.equal(await setPlatformSetting(f.db,'topup_max_cents',1500),true);
    assert.equal(await setPlatformSetting(f.db,'topup_min_cents',1600),false);
    assert.equal(await setPlatformSetting(f.db,'topup_min_cents',1400),true);
    assert.equal(await setPlatformSetting(f.db,'topup_max_cents',1300),false);
    assert.equal(f.value('topup_min_cents'),'1400');
    assert.equal(f.value('topup_max_cents'),'1500');
  }finally{f.close();}
});
test('configuração oposta inválida bloqueia gravação sem corromper banco',async()=>{
  const f=fixture();
  try{
    f.sql.exec("INSERT INTO platform_settings VALUES('topup_max_cents','NaN','2026-10-20')");
    assert.equal(await setPlatformSetting(f.db,'topup_min_cents',1500),false);
    assert.equal(f.value('topup_min_cents'),undefined);
    assert.equal(await setPlatformSetting(f.db,'topup_max_cents',500000),true);
    assert.equal(await setPlatformSetting(f.db,'topup_min_cents',1500),true);
  }finally{f.close();}
});
test('leitura interrompe operação se dados financeiros antigos estão inválidos',async()=>{
  for(const [key,raw] of [['msg_price_cents','NaN'],['msg_max_attempts','0'],['retry_backoff_sec','3.5'],['capture_on','invalid'],['msg_price_cents','9007199254740992']]){
    const f=fixture();
    try{
      f.sql.prepare('INSERT INTO platform_settings VALUES(?,?,?)').run(key,raw,'2026-10-20');
      await assert.rejects(loadPlatformSettings(f.db,0),/Configuração financeira inválida/);
    }finally{f.close();}
  }
});
test('limites persistidos inconsistentes são recusados na leitura',async()=>{
  const f=fixture();
  try{
    f.sql.exec("INSERT INTO platform_settings VALUES('topup_min_cents','3000','2026-10-20'),('topup_max_cents','2000','2026-10-20')");
    await assert.rejects(loadPlatformSettings(f.db,0),/Limites de recarga incompatíveis/);
  }finally{f.close();}
});
test('Super Admin valida entrada e só audita configurações realmente salvas',()=>{
  assert.match(route,/isValidPlatformSetting\(parsed.data.key, parsed.data.value\)/);
  assert.match(route,/const saved = await setPlatformSetting/);
  assert.match(route,/if \(!saved\) return err/);
  assert.match(route,/\.strict\(\)\.safeParse/);
  assert.ok(route.indexOf('if (!saved) return err')<route.indexOf('await audit(c.env.DB, c.get("user"), "platform.setting"'));
});
