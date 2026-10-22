#!/usr/bin/env node
/**
 * TIGU: bootstrap único do Super Admin, limitado ao D1 tigu-staging-db.
 * A senha vem exclusivamente de GitHub Actions Secrets e nunca é impressa.
 * Não publica Worker, não migra banco, não toca em produção.
 */
import { readFileSync } from "node:fs";
import { randomBytes, pbkdf2Sync } from "node:crypto";

const EMAIL = "carlosrykellmy8@gmail.com";
const DATABASE = "tigu-staging-db";
const API = "https://api.cloudflare.com/client/v4";
const URL = "https://tigu-staging.netssh3-0.workers.dev";
const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH || "/dev/null", "utf8"));

async function bootstrap() {
  if (process.env.GITHUB_ACTIONS !== "true" ||
      process.env.GITHUB_EVENT_NAME !== "push" ||
      process.env.GITHUB_REF !== "refs/heads/audit/tigu-primeira-validacao" ||
      process.env.GITHUB_REPOSITORY !== "rykellmy31-star/GESTOR-BARBEARIA" ||
      event.head_commit?.message !== "TIGU_CREATE_SUPER_STAGING_ONCE" ||
      process.env.TIGU_SUPER_STAGING_APPROVED !== "YES") {
    throw Error("Execução não autorizada para staging.");
  }
  const token = process.env.CLOUDFLARE_STAGING_TOKEN || "";
  const account = process.env.CLOUDFLARE_ACCOUNT_ID || "";
  const password = process.env.TIGU_SUPERADMIN_INITIAL_PASSWORD || "";
  if (token.length < 15 || !/^[a-f0-9]{32}$/i.test(account))
    throw Error("Token Cloudflare staging ou Account ID ausente.");
  if (password.length < 12 || password.length > 128)
    throw Error("Secret TIGU_SUPERADMIN_INITIAL_PASSWORD ausente ou fora do limite de 12 a 128 caracteres.");
  const base = API + "/accounts/" + account;
  const request = async (method, path, payload) => {
    const response = await fetch(base + path, {
      method, redirect: "error", signal: AbortSignal.timeout(25000),
      headers: { Authorization: "Bearer " + token, Accept: "application/json",
        ...(payload ? { "Content-Type": "application/json" } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
    });
    if (!response.ok) throw Error("Cloudflare negou acesso (" + response.status + ").");
    const data = await response.json();
    if (data?.success !== true) throw Error("Cloudflare não confirmou operação.");
    return data.result;
  };
  const [dbs, workers, media] = await Promise.all([
    request("GET", "/d1/database?name=" + DATABASE),
    request("GET", "/workers/scripts"),
    request("GET", "/r2/buckets?name_contains=tigu-staging-media"),
  ]);
  const databases = Array.isArray(dbs) ? dbs.filter(x => x?.name === DATABASE) : [];
  const workerCount = Array.isArray(workers) ? workers.filter(x => x?.id === "tigu-staging").length : 0;
  const bucketCount = Array.isArray(media?.buckets) ? media.buckets.filter(x => x?.name === "tigu-staging-media").length : 0;
  if (databases.length !== 1 || workerCount !== 1 || bucketCount !== 1 ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databases[0]?.uuid || ""))
    throw Error("Isolamento de Worker, D1 e R2 staging não confirmado.");
  const databaseId = databases[0].uuid;
  const query = async (sql, params = []) => {
    const result = await request("POST", "/d1/database/" + databaseId + "/query", { sql, params });
    if (!Array.isArray(result) || result.length !== 1 || result[0]?.success !== true)
      throw Error("D1 não confirmou execução SQL.");
    return result[0];
  };
  const previous = await query("SELECT id,platform_role FROM users WHERE email=?1 LIMIT 1", [EMAIL]);
  const rows = previous.results || [];
  if (rows.length > 1 || (rows.length === 1 && rows[0].platform_role !== "superadmin"))
    throw Error("E-mail já pertence a outro perfil; operação recusada sem alterar permissões.");
  const salt = randomBytes(16);
  const iterations = 100000;
  const derived = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const stored = "pbkdf2_sha256$" + iterations + "$" + salt.toString("base64") + "$" + derived.toString("base64");
  if (rows.length === 0) {
    const insert = await query(
      "INSERT INTO users(platform_role,name,email,password_hash,active,must_change_password,created_at) VALUES ('superadmin',?1,?2,?3,1,1,strftime('%Y-%m-%dT%H:%M:%SZ','now')) ON CONFLICT(email) DO NOTHING",
      ["Administrador TIGU", EMAIL, stored]
    );
    if (Number(insert.meta?.changes) !== 1) throw Error("D1 não inseriu conta.");
  } else {
    const update = await query(
      "UPDATE users SET password_hash=?1,active=1,must_change_password=1 WHERE email=?2 AND platform_role='superadmin'",
      [stored, EMAIL]
    );
    if (Number(update.meta?.changes) !== 1) throw Error("D1 não atualizou conta superadmin.");
    await query("DELETE FROM sessions WHERE user_id=?1", [rows[0].id]);
  }
  const check = await query(
    "SELECT platform_role,active,must_change_password FROM users WHERE email=?1 LIMIT 1", [EMAIL]
  );
  const user = check.results?.[0];
  if (check.results?.length !== 1 || user.platform_role !== "superadmin" ||
      Number(user.active) !== 1 || Number(user.must_change_password) !== 1)
    throw Error("Conta alterada, mas verificação de perfil falhou.");
  console.log("TIGU: conta Super Admin registrada no D1 de staging; troca de senha exigida.");
  const response = await fetch(URL + "/api/auth/login", {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(25000),
    headers: { "Content-Type": "application/json", Origin: URL },
    body: JSON.stringify({ email: EMAIL, password }),
  });
  const login = await response.json().catch(() => null);
  if (!response.ok || login?.user?.platform_role !== "superadmin" ||
      login?.user?.must_change_password !== true || login?.next !== "/alterar-senha")
    throw Error("D1 confirmado, mas login remoto ou redirecionamento não validado (HTTP " + response.status + ").");
  console.log("TIGU: login remoto validado e troca obrigatória confirmada.");
}
bootstrap().catch(error => {
  console.error("TIGU bootstrap: " + (error instanceof Error ? error.message : "erro"));
  process.exitCode = 1;
});
