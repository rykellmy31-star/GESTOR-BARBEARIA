#!/usr/bin/env node
/**
 * Provisionamento TIGU estritamente limitado ao D1 e R2 de homologação.
 * GitHub Actions Secret: CLOUDFLARE_STAGING_TOKEN
 * GitHub Actions Variable: CLOUDFLARE_ACCOUNT_ID
 *
 * Modos: check (apenas GET); create (somente dois POST de criação).
 * Não modifica, exclui, migra, publica Workers nem consulta dados pessoais.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ORIGIN = "https://api.cloudflare.com/client/v4";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const D1_NAME = "tigu-staging-db";
const R2_NAME = "tigu-staging-media";
const WORKER_NAME = "tigu-staging";

export async function provisionTiguStaging({ token, accountId, create = false, fetcher = fetch }) {
  if (!token || typeof token !== "string" || token.length < 15)
    throw Error("CLOUDFLARE_STAGING_TOKEN não foi disponibilizado no GitHub Actions.");
  if (!ACCOUNT_ID.test(accountId || ""))
    throw Error("CLOUDFLARE_ACCOUNT_ID não foi disponibilizado ou é inválido.");
  if (typeof create !== "boolean") throw Error("Modo de execução inválido.");

  const prefix = "/accounts/" + accountId;
  const auth = { Authorization: "Bearer " + token, Accept: "application/json" };
  async function api(method, path, body = undefined) {
    const allowedGET = new Set([
      "/user/tokens/verify",
      prefix + "/d1/database?name=" + D1_NAME,
      prefix + "/r2/buckets?name_contains=" + R2_NAME,
      prefix + "/workers/scripts",
    ]);
    const allowedPOST = new Set([prefix + "/d1/database", prefix + "/r2/buckets"]);
    if (method === "GET" ? !allowedGET.has(path) :
        method !== "POST" || !create || !allowedPOST.has(path))
      throw Error("Operação fora da lista permitida de homologação.");
    if (body && !(method === "POST" &&
        ((path.endsWith("/d1/database") && body.name === D1_NAME) ||
         (path.endsWith("/r2/buckets") && body.name === R2_NAME)) &&
        Object.keys(body).length === 1))
      throw Error("Tentativa de alterar recurso fora do escopo TIGU.");
    const response = await fetcher(ORIGIN + path, {
      method, redirect: "error",
      signal: AbortSignal.timeout(15000),
      headers: { ...auth, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok)
      throw Error("Cloudflare rejeitou operação de " + (method === "GET" ? "leitura" : "criação") +
        " (" + response.status + "). Verifique token e permissões.");
    let data;
    try { data = await response.json(); }
    catch { throw Error("Cloudflare retornou JSON inválido."); }
    if (data?.success !== true)
      throw Error("Cloudflare recusou a operação; verifique as permissões e recursos.");
    return data.result;
  }

  const t = await api("GET", "/user/tokens/verify");
  if (t?.status !== "active") throw Error("Token de homologação não está ativo.");
  const read = async () => {
    const d1 = await api("GET", prefix + "/d1/database?name=" + D1_NAME);
    const r2 = await api("GET", prefix + "/r2/buckets?name_contains=" + R2_NAME);
    const scripts = await api("GET", prefix + "/workers/scripts");
    if (!Array.isArray(d1) || !Array.isArray(r2?.buckets) || !Array.isArray(scripts))
      throw Error("API Cloudflare respondeu formato de inventário inesperado.");
    const dbs = d1.filter(x => x?.name === D1_NAME);
    const buckets = r2.buckets.filter(x => x?.name === R2_NAME);
    const workers = scripts.filter(x => x?.id === WORKER_NAME);
    if (dbs.length > 1 || buckets.length > 1 || workers.length > 1)
      throw Error("Há recursos duplicados na homologação; intervenção humana necessária.");
    if (dbs.length === 1 && !UUID.test(dbs[0]?.uuid || ""))
      throw Error("D1 homologação encontrado sem UUID válido.");
    return { db: dbs[0] || null, bucket: buckets[0] || null, worker: workers[0] || null };
  };

  const before = await read();
  const created = { d1: false, r2: false };
  if (create) {
    // Não modifica recursos existentes. Reexecutar é seguro e idempotente.
    if (!before.db) {
      const db = await api("POST", prefix + "/d1/database", { name: D1_NAME });
      if (db?.name !== D1_NAME || !UUID.test(db?.uuid || ""))
        throw Error("D1 criado, mas resposta de identificação inesperada: confira a conta antes de continuar.");
      created.d1 = true;
    }
    if (!before.bucket) {
      const bucket = await api("POST", prefix + "/r2/buckets", { name: R2_NAME });
      if (bucket?.name !== R2_NAME)
        throw Error("R2 criado, mas resposta de identificação inesperada: confira a conta antes de continuar.");
      created.r2 = true;
    }
  }
  const after = create ? await read() : before;
  if (create && (!after.db || !after.bucket))
    throw Error("Cloudflare não confirmou ambos os recursos de homologação.");
  return {
    token: "active", account: "verified",
    staging: { d1: Boolean(after.db), r2: Boolean(after.bucket), worker: Boolean(after.worker) },
    created, existing_resources_modified: false,
    production_resources_modified: false, staging_worker_deployed: false,
    staging_homologated: false, backups_restored: false,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2] || "check";
  try {
    if (!["check", "create"].includes(mode) || process.argv.length > 3)
      throw Error("Uso: node scripts/staging-provision.mjs check|create");
    if (mode === "create" && process.env.TIGU_STAGING_CREATE_APPROVED !== "YES")
      throw Error("Criação não aprovada pelo gate TIGU_STAGING_CREATE_APPROVED.");
    const result = await provisionTiguStaging({
      token: process.env.CLOUDFLARE_STAGING_TOKEN,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      create: mode === "create",
    });
    console.log("TIGU Cloudflare staging — " + mode + "\n" + JSON.stringify(result,null,2));
    console.log("Nenhum Worker publicado, migração, pagamento ou backup remoto executado.");
  } catch (err) {
    console.error("TIGU Cloudflare staging: " + (err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }
}
