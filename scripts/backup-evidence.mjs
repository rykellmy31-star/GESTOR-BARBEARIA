#!/usr/bin/env node
/**
 * Verifica evidências LOCAIS de backup D1 (export SQL) e R2 (diretório de cópia).
 * Nunca acessa rede ou usa Wrangler, e jamais faz restore em recurso remoto.
 * Um resultado positivo NÃO homologa cópia/restore da Cloudflare.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve, relative, sep, isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

const needed = [
  "companies", "users", "company_memberships", "subscriptions",
  "customers", "bookings", "booking_slots", "barbers", "services",
  "products", "orders", "order_items", "wallets", "wallet_transactions",
  "topup_orders", "subscription_invoices", "message_jobs", "audit_log",
  "payment_webhook_events",
];

export function auditD1Export(sql) {
  if (typeof sql !== "string" || sql.length < 64)
    throw Error("Exportação SQL D1 ausente ou muito curta.");
  // A exportação deve ser da Cloudflare e de origem confiável: não execute
  // scripts arbitrários, anexação de bancos nem comandos para escrever arquivos.
  if (/\b(?:ATTACH|DETACH|VACUUM|load_extension|writefile|readfile)\b/i.test(sql))
    throw Error("Exportação contém comandos não permitidos para conferência local.");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(sql);
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check;
    if (integrity !== "ok") throw Error("Integridade SQLite inválida.");
    const violations = db.prepare("PRAGMA foreign_key_check").all();
    if (violations.length) throw Error("Exportação contém referências inválidas: " + violations.length);
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(x => x.name));
    const missing = needed.filter(name => !tables.has(name));
    if (missing.length) throw Error("Tabelas essenciais ausentes: " + missing.join(", "));
    // Informação agregada, sem expor clientes ou detalhes de pagamento.
    const counts = {};
    for (const t of ["companies", "customers", "bookings", "orders", "wallet_transactions", "message_jobs"]) {
      counts[t] = Number(db.prepare("SELECT count(*) AS n FROM " + t).get().n);
    }
    return { integrity: "ok", foreign_keys: "ok", essential_tables: needed.length, counts };
  } finally {
    db.close();
  }
}

function validKey(key) {
  return typeof key === "string" && key.length > 0 && key.length <= 1024 &&
    !key.startsWith("/") && !key.includes("\\") && !key.includes("\0") &&
    !key.includes(":") && key.split("/").every(part => part && part !== "." && part !== "..");
}

export function auditR2Copy(root, manifest) {
  if (!Array.isArray(manifest) || manifest.length === 0)
    throw Error("Manifesto R2 vazio ou inválido; não pode comprovar cópia.");
  if (!root || !lstatSync(root).isDirectory()) throw Error("Diretório de cópia R2 inválido.");
  const base = realpathSync(resolve(root));
  const seen = new Set();
  let totalBytes = 0;
  for (const item of manifest) {
    if (!item || !validKey(item.key)) throw Error("Chave R2 inválida no manifesto.");
    if (seen.has(item.key)) throw Error("Chave R2 duplicada: " + item.key);
    seen.add(item.key);
    if (!Number.isSafeInteger(item.size) || item.size < 0 ||
        typeof item.sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(item.sha256))
      throw Error("Metadados R2 inválidos: " + item.key);
    const full = resolve(base, item.key);
    const rel = relative(base, full);
    if (!rel || rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel))
      throw Error("Arquivo fora do diretório R2: " + item.key);
    // Evita seguir links simbólicos em qualquer componente do caminho.
    let current = base;
    for (const part of item.key.split("/")) {
      current = resolve(current, part);
      const stat = lstatSync(current);
      if (stat.isSymbolicLink()) throw Error("Links simbólicos não são permitidos em cópias R2.");
    }
    if (!lstatSync(full).isFile()) throw Error("Objeto R2 não é arquivo: " + item.key);
    const bytes = readFileSync(full);
    if (bytes.length !== item.size) throw Error("Tamanho divergente: " + item.key);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest !== item.sha256.toLowerCase()) throw Error("SHA-256 divergente: " + item.key);
    totalBytes += bytes.length;
  }
  return { objects_verified: manifest.length, bytes_verified: totalBytes };
}

export function verifyLocalEvidence({sqlFile, r2Directory, manifestFile}) {
  if (!sqlFile || !r2Directory || !manifestFile)
    throw Error("Informe --d1-sql EXPORT.sql --r2-dir DIRETORIO --r2-manifest MANIFESTO.json.");
  const sql = readFileSync(sqlFile, "utf8");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  return { d1: auditD1Export(sql), r2: auditR2Copy(r2Directory, manifest) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 6 || !["--d1-sql", "--r2-dir", "--r2-manifest"].every(x => args.includes(x)))
      throw Error("Uso: node scripts/backup-evidence.mjs --d1-sql EXPORT.sql --r2-dir COPIA_R2 --r2-manifest MANIFESTO.json");
    const get = name => args[args.indexOf(name) + 1];
    const result = verifyLocalEvidence({
      sqlFile: get("--d1-sql"), r2Directory: get("--r2-dir"), manifestFile: get("--r2-manifest"),
    });
    console.log(JSON.stringify({ local_evidence: "verified", ...result }, null, 2));
    console.log("ATENÇÃO: isto NÃO comprova backup/restore D1 ou R2 na Cloudflare.");
  } catch (error) {
    console.error("Falha na evidência de backup:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
