import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { auditD1Export, auditR2Copy, verifyLocalEvidence } from "./backup-evidence.mjs";

const dir = resolve(import.meta.dirname,"../migrations");
const migrationNames = readdirSync(dir).filter(x => /^\d{4}_.*\.sql$/.test(x)).sort();
const sql = migrationNames.map(x => readFileSync(join(dir,x),"utf8")).join("\n");
const sha = value => createHash("sha256").update(value).digest("hex");
function withDir(fn) {
  const root = mkdtempSync(join(tmpdir(),"tigu-backup-evidence-"));
  try { return fn(root); } finally { rmSync(root,{force:true,recursive:true}); }
}
test("audita export SQL contendo todas as migrações e não divulga dados pessoais",()=>{
  assert.equal(migrationNames.length,27);
  assert.ok(migrationNames.includes("0104_evolution_whatsapp.sql"));
  assert.ok(migrationNames.includes("0103_manual_platform_subscriptions.sql"));
  assert.ok(migrationNames.includes("0101_barber_service_duration.sql"));
  assert.ok(migrationNames.includes("0102_booking_checkin_cancel_reason.sql"));
  assert.ok(migrationNames.includes("0100_seller_pix.sql"));
  assert.ok(migrationNames.includes("0099_seller_mercadopago_oauth.sql"));
  const fixture = sql + "\nINSERT INTO companies(id,slug,name) VALUES (901,'evidence','Empresa fictícia');\n" +
    "INSERT INTO customers(company_id,name,phone) VALUES (901,'Pessoa privada','73999998888');\n";
  const result = auditD1Export(fixture);
  assert.deepEqual(result.counts,{companies:1,customers:1,bookings:0,orders:0,
    wallet_transactions:0,message_jobs:0});
  assert.equal(result.integrity,"ok");
  assert.equal(result.foreign_keys,"ok");
  assert.ok(!JSON.stringify(result).includes("73999998888"),"Saída não pode revelar contatos");
});
test("recusa SQL truncado, esquema incompatível, comando que pode escrever arquivos e vínculos órfãos",()=>{
  assert.throws(()=>auditD1Export("SELECT 1"),/muito curta/);
  assert.throws(()=>auditD1Export("CREATE TABLE IF NOT EXISTS teste(id INTEGER PRIMARY KEY);".repeat(3)),/Tabelas essenciais/);
  assert.throws(()=>auditD1Export(sql+"\nATTACH DATABASE '/tmp/arquivo' AS outro;"),/não permitidos/);
  const broken=sql+"\nPRAGMA foreign_keys=OFF;\n"+
    "INSERT INTO customers(company_id,name,phone) VALUES (999999,'Pessoa','73999997777');\nPRAGMA foreign_keys=ON;\n";
  assert.throws(()=>auditD1Export(broken),/referências inválidas/);
});
test("verifica todos os objetos de um manifesto R2 com SHA-256, conteúdo e tamanho",()=>withDir(root=>{
  mkdirSync(join(root,"shop"),{recursive:true});
  const first=Buffer.from("imagem-ficticia-1"),second=Buffer.from("imagem-ficticia-2");
  writeFileSync(join(root,"shop","profile.png"),first);
  writeFileSync(join(root,"outro.webp"),second);
  const manifest=[
    {key:"shop/profile.png",size:first.length,sha256:sha(first)},
    {key:"outro.webp",size:second.length,sha256:sha(second)},
  ];
  assert.deepEqual(auditR2Copy(root,manifest),{
    objects_verified:2,bytes_verified:first.length+second.length,
  });
  writeFileSync(join(root,"shop","profile.png"),"imagem-adulterada");
  assert.throws(()=>auditR2Copy(root,manifest),/divergente/);
}));
test("rejeita manifesto falso, caminho traversal, duplicatas, arquivo simbólico ou arquivo ausente",()=>withDir(root=>{
  const data=Buffer.from("dados-de-teste");
  writeFileSync(join(root,"a.png"),data);
  const valid={key:"a.png",size:data.length,sha256:sha(data)};
  assert.throws(()=>auditR2Copy(root,[]),/vazio/);
  assert.throws(()=>auditR2Copy(root,[{...valid,key:"../arquivo"}]),/inválida/);
  assert.throws(()=>auditR2Copy(root,[valid,valid]),/duplicada/);
  assert.throws(()=>auditR2Copy(root,[{...valid,key:"nada.png"}]),/ENOENT/);
  assert.throws(()=>auditR2Copy(root,[{...valid,size:data.length+1}]),/Tamanho divergente/);
  assert.throws(()=>auditR2Copy(root,[{...valid,sha256:"b".repeat(64)}]),/SHA-256 divergente/);
  symlinkSync(join(root,"a.png"),join(root,"link.png"));
  assert.throws(()=>auditR2Copy(root,[{...valid,key:"link.png"}]),/Links simbólicos/);
}));
test("CLI de evidência local aprova cópia íntegra, recusa corrupção e não precisa de rede",()=>withDir(root=>{
  const sqlFile=join(root,"backup.sql");
  const r2=join(root,"r2");
  const manifestFile=join(root,"manifest.json");
  mkdirSync(r2);
  writeFileSync(sqlFile,sql);
  const data=Buffer.from("arquivo-privado-ficticio");
  writeFileSync(join(r2,"imagem.png"),data);
  writeFileSync(manifestFile,JSON.stringify([{key:"imagem.png",size:data.length,sha256:sha(data)}]));
  const args=["scripts/backup-evidence.mjs","--d1-sql",sqlFile,"--r2-dir",r2,"--r2-manifest",manifestFile];
  const good=spawnSync(process.execPath,args,{cwd:resolve(import.meta.dirname,".."),encoding:"utf8"});
  assert.equal(good.status,0,good.stderr);
  assert.match(good.stdout,/"local_evidence": "verified"/);
  assert.doesNotMatch(good.stdout,/password_hash|token_hash|customer_phone/);
  writeFileSync(join(r2,"imagem.png"),"alterado");
  const bad=spawnSync(process.execPath,args,{cwd:resolve(import.meta.dirname,".."),encoding:"utf8"});
  assert.equal(bad.status,1,bad.stdout);
  assert.match(bad.stderr,/divergente/);
  assert.throws(()=>verifyLocalEvidence({sqlFile,r2Directory:r2,manifestFile}),/divergente/);
}));
