import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {DatabaseSync} from 'node:sqlite';

const read=path=>readFileSync(new URL('../'+path,import.meta.url),'utf8');
const text=stripTypeScriptTypes(read('api/lib/messaging/super-message-filter.ts'),{mode:'strip'});
const {globalMessageListFilter,parseGlobalMessageCursor,parseOptionalMessageCompanyId}=
  await import('data:text/javascript;base64,'+Buffer.from(text).toString('base64'));
const route=read('api/routes/super.ts');
const panel=read('src/pages/super/MessagesPage.tsx');
const jobs=read('api/lib/messaging/jobs.ts');
const sweepSource=jobs.match(/async function sweepStuckJobs\(db: D1Database,[\s\S]*?\n}\n(?=\nasync function maybeLowBalanceAlert)/)?.[0];
assert.ok(sweepSource,'Real stuck job reconciliation function should be present');
const runnable=stripTypeScriptTypes("const nowIso=()=> '2026-10-20T18:00:00Z';\n"+sweepSource+"\nexport { sweepStuckJobs };",{mode:'strip'});
const {sweepStuckJobs}=await import('data:text/javascript;base64,'+Buffer.from(runnable).toString('base64'));

function jobsDb(){
  const db=new DatabaseSync(':memory:');
  db.exec("CREATE TABLE message_jobs(id INTEGER PRIMARY KEY,company_id INTEGER NOT NULL,status TEXT,last_error TEXT,provider_msg_id TEXT,last_attempt_at TEXT,sent_at TEXT,updated_at TEXT,next_attempt_at TEXT,price_cents INTEGER)");
  const ins=db.prepare("INSERT INTO message_jobs(id,company_id,status,last_error,provider_msg_id,last_attempt_at,next_attempt_at,price_cents) VALUES (?1,?2,'sending','aguardando','', '2026-01-01T00:00:00Z','2026-10-21T00:00:00Z',100)");
  ins.run({1:1,2:3});ins.run({1:2,2:4});
  return {db,adapter:{prepare:q=>({bind:(...params)=>({run:async()=>db.prepare(q).run(Object.fromEntries(params.map((v,i)=>[i+1,v])))})})}};
}

test('no invalid company id may fallback to global dispatch',()=>{
  assert.equal(parseOptionalMessageCompanyId(undefined),undefined);
  assert.equal(parseOptionalMessageCompanyId('3'),3);
  for(const invalid of ['','0','-1','03','1.5','1e2','NaN','Infinity',' 3','9007199254740992'])
    assert.equal(parseOptionalMessageCompanyId(invalid),null,invalid);
  assert.match(route,/parseOptionalMessageCompanyId\(c\.req\.query\("companyId"\)\)/);
  assert.match(route,/if \(companyId === null\) return err/);
  assert.match(jobs,/Number\.isSafeInteger\(opts\.companyId\)/);
  assert.match(jobs,/sweepStuckJobs\(db, opts\.companyId, opts\.provider\)/);
});

test('stale webhook cleanup for one barber shop does not mutate another',async()=>{
  const {db,adapter}=jobsDb();
  try{
    await sweepStuckJobs(adapter,3);
    const one=db.prepare('SELECT last_error,next_attempt_at FROM message_jobs WHERE id=1').get();
    const two=db.prepare('SELECT last_error,next_attempt_at FROM message_jobs WHERE id=2').get();
    assert.match(one.last_error,/Pendente de conferência/);
    assert.equal(one.next_attempt_at,null);
    assert.equal(two.last_error,'aguardando');
    assert.equal(two.next_attempt_at,'2026-10-21T00:00:00Z');
  }finally{db.close();}
});

test('global job recovery remains supported when no company is supplied',async()=>{
  const {db,adapter}=jobsDb();
  try{
    await sweepStuckJobs(adapter);
    assert.equal(db.prepare("SELECT count(*) n FROM message_jobs WHERE last_error LIKE 'Pendente de conferência:%'").get().n,2);
  }finally{db.close();}
});

test('message cursor is numeric, safe and strictly positive',()=>{
  assert.equal(parseGlobalMessageCursor(undefined),null);
  assert.equal(parseGlobalMessageCursor(''),null);
  assert.equal(parseGlobalMessageCursor('100'),100);
  for(const bad of ['0','01','1.2','NaN','Infinity',' 4','9007199254740992'])
    assert.equal(parseGlobalMessageCursor(bad),undefined,bad);
});

test('global conflict filter retrieves old messages beyond initial 100',()=>{
  const db=new DatabaseSync(':memory:');
  try{
    db.exec("CREATE TABLE message_jobs(id INTEGER PRIMARY KEY,status TEXT,last_error TEXT)");
    const ins=db.prepare('INSERT INTO message_jobs(id,status,last_error) VALUES(?1,?2,?3)');
    for(let i=1;i<=255;i++)ins.run({1:i,2:i<4?'failed':'sent',3:i<4?'[CONFLITO META: divergencia]':''});
    let cursor=null, ids=[];
    for(let k=0;k<5;k++){
      const {where,binds}=globalMessageListFilter('conflict',cursor);
      const rows=db.prepare('SELECT j.id FROM message_jobs j '+where+' ORDER BY j.id DESC LIMIT 101')
        .all(Object.fromEntries(binds.map((v,i)=>[i+1,v])));
      const page=rows.slice(0,100);
      ids.push(...page.map(v=>v.id));
      if(rows.length<=100)break;
      cursor=page.at(-1).id;
    }
    assert.deepEqual(ids,[3,2,1]);
    assert.equal(globalMessageListFilter('sent',200).where,'WHERE j.status = ?1 AND j.id < ?2');
    assert.deepEqual(globalMessageListFilter('sent',200).binds,['sent',200]);
  }finally{db.close();}
});

test('API and Super Admin interface expose paginated filtered query',()=>{
  assert.match(route,/globalMessageListFilter\(c\.req\.query\("status"\), beforeId\)/);
  assert.match(route,/ORDER BY j\.id DESC LIMIT 101/);
  assert.match(route,/next_before_id:/);
  assert.match(panel,/useInfiniteQuery/);
  assert.match(panel,/<option value="conflict">conflitos de envio<\/option>/);
  assert.match(panel,/Carregar mensagens anteriores/);
});
