#!/usr/bin/env node
// ============================================================================
// Cria (ou redefine) o superadmin da plataforma Tigu, via wrangler d1 execute.
// Uso:
//   npm run setup:super -- --email super@tigu.app --name "Equipe Tigu" [--password '...'] [--remote]
// Sem --password, gera uma senha forte e mostra UMA única vez.
// ============================================================================
import { execFileSync } from "node:child_process";
import { randomBytes, pbkdf2Sync } from "node:crypto";

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const remote = argv.includes("--remote");
const email = (arg("email") || "super@tigu.app").toLowerCase();
const name = arg("name") || "Equipe Tigu";
let password = arg("password");
if (!password) { password = `Tigu!${randomBytes(9).toString("base64url")}`; }

// Mesmo formato do api/lib/crypto.ts: pbkdf2_sha256$150000$b64(salt)$b64(hash)
const ITER = 150000;
const salt = randomBytes(16);
const hash = pbkdf2Sync(Buffer.from(password, "utf8"), salt, ITER, 32, "sha256");
const b64 = (b) => b.toString("base64");
const stored = `pbkdf2_sha256$${ITER}$${b64(salt)}$${b64(hash)}`;
const q = (s2) => `'${String(s2).replace(/'/g, "''")}'`;

const sql = `
INSERT INTO users (platform_role, name, email, password_hash, active, created_at)
VALUES ('superadmin', ${q(name)}, ${q(email)}, ${q(stored)}, 1, strftime('%Y-%m-%dT%H:%M:%SZ','now'))
ON CONFLICT(email) DO UPDATE SET platform_role='superadmin', active=1, password_hash=excluded.password_hash, must_change_password=0;
`;
execFileSync("npx", ["wrangler", "d1", "execute", "tigu-db", remote ? "--remote" : "--local", "--command", sql.trim()], { stdio: "inherit" });
console.log(`\n✔ superadmin ${email}\n  senha: ${password}\n  (guarde agora — não é recuperável; redefina rodando o script de novo)`);
