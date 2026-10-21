/** Migrações reais aplicadas à base SQLite em memória; sem serviços externos. */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";

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

test("a cadeia completa contém exatamente as 18 migrações sequenciais e é íntegra",()=>{
  assert.equal(files.length,18);
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
    assert.ok(col("bookings").has("payment_choice"));
    assert.ok(col("booking_payments").has("amount_cents"));
    assert.ok(col("topup_orders").has("notification_sent_at"));
    assert.ok(col("payment_webhook_events").has("attempt_count"));
    assert.ok(col("message_conflict_reviews").has("audit_snapshot_version"));
    const indexes=new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map(x=>x.name));
    for(const name of ["idx_orders_company_paid_at","idx_topups_notification_reconcile","idx_payment_webhook_retry","idx_message_conflict_reviews_job","idx_audit_message_conflict_lookup","idx_message_jobs_meta_conflict_page","idx_message_jobs_status_page","idx_booking_payments_company_status"]){
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


test('upgrade de base existente preserva pagamentos e somente recargas pagas ganham marcador histórico',()=>{
  const db=new DatabaseSync(":memory:");
  try{
    db.exec("PRAGMA foreign_keys=ON;");
    for(const name of files.slice(0,10)) db.exec(readFileSync(join(directory,name),"utf8"));
    db.exec("INSERT INTO companies(id,slug,name) VALUES (91,'loja-antiga','Loja Antiga'),(92,'outra-loja','Outra Loja')");
    db.exec("INSERT INTO topup_orders(id,company_id,code,amount_cents,status,paid_at,credited_at) VALUES (101,91,'TOPUP-HIST-1',1000,'paid','2026-09-01T10:00:00Z','2026-09-01T10:01:00Z'),(102,92,'TOPUP-PEND-2',2000,'pending',NULL,NULL)");
    db.exec("INSERT INTO orders(id,company_id,code,customer_name,customer_phone,status,total_cents) VALUES (201,91,'PED-HIST-1','Cliente','5599999999999','pago',5000)");
    db.exec("INSERT INTO payment_webhook_events(id,provider,event_uid,payload,processed) VALUES (301,'mercadopago','webhook-historico-1','{}',1)");
    for(const name of files.slice(10)) db.exec(readFileSync(join(directory,name),"utf8"));
    const paid=db.prepare("SELECT company_id,amount_cents,status,paid_at,credited_at,notification_sent_at FROM topup_orders WHERE id=101").get();
    assert.deepEqual({...paid},{company_id:91,amount_cents:1000,status:'paid',paid_at:'2026-09-01T10:00:00Z',credited_at:'2026-09-01T10:01:00Z',notification_sent_at:'2026-09-01T10:01:00Z'});
    const pending=db.prepare("SELECT company_id,status,notification_sent_at FROM topup_orders WHERE id=102").get();
    assert.deepEqual({...pending},{company_id:92,status:'pending',notification_sent_at:null});
    assert.deepEqual({...db.prepare("SELECT status,total_cents,paid_at FROM orders WHERE id=201").get()},{status:'pago',total_cents:5000,paid_at:null});
    assert.deepEqual({...db.prepare("SELECT processed,attempt_count,last_attempt_at FROM payment_webhook_events WHERE id=301").get()},{processed:1,attempt_count:0,last_attempt_at:null});
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(),[]);
  }finally{db.close();}
});


/**
 * Testa uma cópia/recuperação LOCAL de SQLite com todas as migrações e dados
 * FICTÍCIOS. Não representa backup Cloudflare D1 nem objetos R2 remotos.
 */
test("backup SQLite íntegro restaura empresas, pagamentos, carteira e idempotência",()=>{
  const dir=mkdtempSync(join(tmpdir(),"tigu-restore-smoke-"));
  const backup=join(dir,"snapshot.sqlite");
  const source=migrated();
  let restored;
  try {
    source.exec(String.raw`
      INSERT INTO companies(id,slug,name) VALUES (101,'restaura-alfa','Empresa Alfa'),(202,'restaura-bravo','Empresa Bravo');
      INSERT INTO users(id,name,email,password_hash) VALUES
        (11,'Dono Alfa','alfa@restore.test','senha-ficticia'),
        (22,'Dono Bravo','bravo@restore.test','senha-ficticia');
      INSERT INTO company_memberships(company_id,user_id,role) VALUES (101,11,'owner'),(202,22,'owner');
      INSERT OR IGNORE INTO plans(code,name) VALUES('pro','Pro');
      INSERT INTO subscriptions(company_id,plan_code,status,period_end) VALUES
        (101,'pro','active','2026-11-20T00:00:00Z'),(202,'free','trial','2026-11-04T00:00:00Z');
      INSERT INTO wallets(company_id,balance_cents,lifetime_recharged_cents)
        VALUES(101,4000,4000),(202,0,0);
      INSERT INTO wallet_transactions(id,company_id,type,amount_cents,balance_after,ref_type,ref_id,idempotency_key)
        VALUES(71,101,'topup',4000,4000,'topup_order','81','restore:topup:81');
      INSERT INTO topup_orders(id,company_id,code,amount_cents,status,provider,provider_payment_id,
        paid_at,credited_at,credited_tx_id,notification_sent_at)
        VALUES(81,101,'RGA-RESTORE-81',4000,'paid','mercadopago','90081',
        '2026-10-20T12:00:00Z','2026-10-20T12:01:00Z',71,'2026-10-20T12:01:00Z');
      INSERT INTO subscription_invoices(id,company_id,code,plan_code,amount_cents,status,provider_payment_id,paid_at)
        VALUES(91,101,'TIGU-SUB-RESTORE','pro',2500,'paid','90091','2026-10-20T12:02:00Z');
      INSERT INTO payment_webhook_events(id,provider,event_uid,payload,processed,attempt_count,last_attempt_at)
        VALUES(95,'mercadopago','mercadopago:90081:payment.updated','{}',1,2,'2026-10-20T12:02:00Z');
      INSERT INTO products(id,company_id,slug,name,price_cents,stock)
        VALUES(301,101,'kit-restore','Kit Fictício',7500,3);
      INSERT INTO orders(id,company_id,code,customer_name,customer_phone,status,total_cents,paid_at)
        VALUES(501,101,'ORDER-RESTORE-1','Comprador Fictício','5500000000000','pago',7500,'2026-10-20T12:03:00Z');
      INSERT INTO order_items(order_id,product_id,product_name,qty,unit_price_cents)
        VALUES(501,301,'Kit Fictício',1,7500);
    `);
    const queries={
      companies:"SELECT id,slug,name FROM companies WHERE id IN (101,202) ORDER BY id",
      memberships:"SELECT company_id,user_id,role FROM company_memberships WHERE company_id IN (101,202) ORDER BY company_id",
      subscriptions:"SELECT company_id,plan_code,status,period_end FROM subscriptions WHERE company_id IN (101,202) ORDER BY company_id",
      wallets:"SELECT company_id,balance_cents,lifetime_recharged_cents FROM wallets WHERE company_id IN (101,202) ORDER BY company_id",
      ledger:"SELECT company_id,type,amount_cents,balance_after,ref_id,idempotency_key FROM wallet_transactions WHERE id=71",
      topups:"SELECT company_id,code,status,amount_cents,credited_tx_id,notification_sent_at FROM topup_orders WHERE id=81",
      invoices:"SELECT company_id,code,status,amount_cents,paid_at FROM subscription_invoices WHERE id=91",
      webhooks:"SELECT provider,event_uid,processed,attempt_count,last_attempt_at FROM payment_webhook_events WHERE id=95",
      products:"SELECT company_id,slug,stock FROM products WHERE id=301",
      orders:"SELECT company_id,code,status,total_cents,paid_at FROM orders WHERE id=501",
      items:"SELECT order_id,product_id,qty,unit_price_cents FROM order_items WHERE order_id=501",
    };
    const snapshot=db=>Object.fromEntries(Object.entries(queries).map(([key,query])=>
      [key,db.prepare(query).all().map(row=>({...row}))]));
    const expected=snapshot(source);
    const escaped=backup.replaceAll("'","''");
    source.exec("VACUUM INTO '"+escaped+"'");
    const data=readFileSync(backup);
    assert.equal(data.subarray(0,16).toString("utf8"),"SQLite format 3\u0000");
    const digest=createHash("sha256").update(data).digest("hex");
    // Uma escrita posterior na base original não pode alterar o backup fechado.
    source.exec("UPDATE wallets SET balance_cents=3500 WHERE company_id=101");
    restored=new DatabaseSync(backup);
    restored.exec("PRAGMA foreign_keys=ON;");
    assert.equal(restored.prepare("PRAGMA integrity_check").get().integrity_check,"ok");
    assert.deepEqual(restored.prepare("PRAGMA foreign_key_check").all(),[]);
    assert.deepEqual(snapshot(restored),expected);
    assert.equal(createHash("sha256").update(readFileSync(backup)).digest("hex"),digest);
    assert.throws(()=>restored.exec(String.raw`
      INSERT INTO wallet_transactions(company_id,type,amount_cents,balance_after,idempotency_key)
      VALUES(101,'topup',4000,4000,'restore:topup:81')
    `),/UNIQUE/);
    assert.throws(()=>restored.exec(
      "INSERT INTO company_memberships(company_id,user_id,role) VALUES(999999,11,'owner')"
    ),/FOREIGN KEY/);
  }finally{
    restored?.close();
    source.close();
    rmSync(dir,{recursive:true,force:true});
  }
});

test("backup SQLite truncado é rejeitado no teste de integridade",()=>{
  const dir=mkdtempSync(join(tmpdir(),"tigu-restore-corrupt-"));
  const backup=join(dir,"snapshot.sqlite");
  const damaged=join(dir,"damaged.sqlite");
  const source=migrated();
  let copy;
  try{
    source.exec("VACUUM INTO '"+backup.replaceAll("'","''")+"'");
    const original=readFileSync(backup);
    assert.ok(original.length>512);
    writeFileSync(damaged,original.subarray(0,400));
    copy=new DatabaseSync(damaged);
    assert.throws(()=>copy.prepare("PRAGMA integrity_check").get(),/database|malformed|disk|error/i);
  }finally{
    copy?.close();
    source.close();
    rmSync(dir,{recursive:true,force:true});
  }
});
