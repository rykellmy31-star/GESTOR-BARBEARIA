/** Migrações reais aplicadas à base SQLite em memória; sem serviços externos. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join,resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const directory=resolve(import.meta.dirname,"../migrations");
const files=readdirSync(directory).filter(f=>/^\d{4}_[\w-]+\.sql$/.test(f)).sort();

function migrated(){
  const db=new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON;");
  for(const name of files){
    try{db.exec(readFileSync(join(directory,name),"utf8"));}
    catch(e){db.close();throw new Error("Migration "+name+" failed: "+e.message,{cause:e});}
  }
  return db;
}

test("a cadeia completa contém exatamente as 17 migrações sequenciais e é íntegra",()=>{
  assert.equal(files.length,17);
  files.forEach((f,i)=>assert.equal(Number(f.slice(0,4)),i+1));
  const db=migrated();
  try{
    assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
    assert.equal(db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name='message_conflict_reviews'").get().n,1);
  }finally{db.close();}
});

test("colunas de dinheiro e índices de auditoria/paginação foram criados",()=>{
  const db=migrated();
  try{
    const col=t=>new Set(db.prepare("PRAGMA table_info("+t+")").all().map(x=>x.name));
    assert.ok(col("orders").has("paid_at"));
    assert.ok(col("topup_orders").has("notification_sent_at"));
    assert.ok(col("payment_webhook_events").has("attempt_count"));
    assert.ok(col("message_conflict_reviews").has("audit_snapshot_version"));
    const indexes=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(x=>x.name));
    for(const name of ["idx_orders_company_paid_at","idx_topups_notification_reconcile","idx_payment_webhook_retry","idx_message_conflict_reviews_job","idx_audit_message_conflict_lookup","idx_message_jobs_meta_conflict_page","idx_message_jobs_status_page"]){
      assert.ok(indexes.has(name),"index missing: "+name);
    }
  }finally{db.close();}
});

test("busca de conflitos históricos usa o índice parcial",()=>{
  const db=migrated();
  try{
    const plans=db.prepare("EXPLAIN QUERY PLAN SELECT id FROM message_jobs WHERE instr(COALESCE(last_error,''),'[CONFLITO META:')>0 AND id<2000 ORDER BY id DESC LIMIT 100").all();
    assert.ok(plans.some(x=>x.detail.includes("idx_message_jobs_meta_conflict_page")),JSON.stringify(plans));
  }finally{db.close();}
});
