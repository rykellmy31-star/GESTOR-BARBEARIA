import test from "node:test";
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {DatabaseSync} from "node:sqlite";
const source=readFileSync(new URL("../api/lib/seller-mercadopago-oauth.ts",import.meta.url),"utf8");
const start=source.indexOf("const saved=await c.env.DB.prepare(");
assert.ok(start>=0);
const first=source.indexOf(String.fromCharCode(96),start);
const last=source.indexOf(String.fromCharCode(96),first+1);
const sql=source.slice(first+1,last);
function setup(){const d=new DatabaseSync(":memory:");
d.exec("CREATE TABLE seller_mp_oauth_pending (state_hash TEXT PRIMARY KEY,company_id INTEGER,barber_id INTEGER,user_id INTEGER,used_at TEXT,expires_at TEXT NOT NULL DEFAULT '2026-10-30T00:00:00Z');");
d.exec("CREATE TABLE seller_mp_accounts (company_id INTEGER,barber_id INTEGER,mp_user_id TEXT,access_ciphertext TEXT,refresh_ciphertext TEXT,expires_at TEXT,connected_by INTEGER,connected_at TEXT,updated_at TEXT,PRIMARY KEY(company_id,barber_id));");
d.exec("CREATE UNIQUE INDEX idx_seller_mp_accounts_mp_account ON seller_mp_accounts(mp_user_id);");
return d;}
const bind=(hash)=>[10,20,"345","encrypted-access","encrypted-refresh","2026-10-30T00:00:00Z",30,"2026-10-23T00:00:00Z",hash];
test("OAuth persiste conta com state consumido",()=>{const d=setup();try{
d.prepare("INSERT INTO seller_mp_oauth_pending VALUES (?,?,?,?,?)").run("state-1",10,20,30,"2026-10-23T00:00:00Z");
assert.equal(d.prepare(sql).run(...bind("state-1")).changes,1);
assert.equal(d.prepare("SELECT count(*) AS n FROM seller_mp_accounts").get().n,1);
}finally{d.close();}});
test("OAuth não reconecta após desconexão",()=>{const d=setup();try{
d.prepare("INSERT INTO seller_mp_oauth_pending VALUES (?,?,?,?,?)").run("state-2",10,20,30,"2026-10-23T00:00:00Z");
d.prepare("DELETE FROM seller_mp_oauth_pending WHERE company_id=? AND barber_id=?").run(10,20);
assert.equal(d.prepare(sql).run(...bind("state-2")).changes,0);
assert.equal(d.prepare("SELECT count(*) AS n FROM seller_mp_accounts").get().n,0);
}finally{d.close();}});
test("OAuth impede vínculo entre empresas diferentes",()=>{const d=setup();try{
d.prepare("INSERT INTO seller_mp_oauth_pending VALUES (?,?,?,?,?)").run("state-3",11,21,31,"2026-10-23T00:00:00Z");
assert.equal(d.prepare(sql).run(...bind("state-3")).changes,0);
assert.equal(d.prepare("SELECT count(*) AS n FROM seller_mp_accounts").get().n,0);
}finally{d.close();}});
test("OAuth não sobrescreve vínculo existente com state de outro profissional",()=>{const d=setup();try{
d.prepare("INSERT INTO seller_mp_accounts VALUES (?,?,?,?,?,?,?,?,?)").run(10,20,"345","original-access","original-refresh","2026-10-30T00:00:00Z",30,"2026-10-23T00:00:00Z","2026-10-23T00:00:00Z");
d.prepare("INSERT INTO seller_mp_oauth_pending VALUES (?,?,?,?,?)").run("state-foreign",10,21,31,"2026-10-23T00:00:00Z");
assert.equal(d.prepare(sql).run(...bind("state-foreign")).changes,0);
assert.equal(d.prepare("SELECT access_ciphertext FROM seller_mp_accounts WHERE company_id=10 AND barber_id=20").get().access_ciphertext,"original-access");
}finally{d.close();}});
test("OAuth impede mesmo recebedor Mercado Pago em dois profissionais",()=>{const d=setup();try{
d.prepare("INSERT INTO seller_mp_accounts VALUES (?,?,?,?,?,?,?,?,?)").run(10,20,"345","original-access","original-refresh","2026-10-30T00:00:00Z",30,"2026-10-23T00:00:00Z","2026-10-23T00:00:00Z");
d.prepare("INSERT INTO seller_mp_oauth_pending VALUES (?,?,?,?,?)").run("same-mp",11,21,31,"2026-10-23T00:00:00Z");
assert.throws(()=>d.prepare(sql).run(11,21,"345","other-access","other-refresh","2026-10-30T00:00:00Z",31,"2026-10-23T00:00:00Z","same-mp"),/UNIQUE constraint failed/);
assert.equal(d.prepare("SELECT count(*) AS n FROM seller_mp_accounts").get().n,1);
}finally{d.close();}});
test("OAuth não grava autorização expirada mesmo após troca de token",()=>{const d=setup();try{
d.prepare("INSERT INTO seller_mp_oauth_pending (state_hash,company_id,barber_id,user_id,used_at,expires_at) VALUES (?,?,?,?,?,?)").run("expired",10,20,30,"2026-10-23T00:00:00Z","2026-10-22T00:00:00Z");
assert.equal(d.prepare(sql).run(...bind("expired")).changes,0);
assert.equal(d.prepare("SELECT count(*) AS n FROM seller_mp_accounts").get().n,0);
}finally{d.close();}});
