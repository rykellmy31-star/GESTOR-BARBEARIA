#!/usr/bin/env node
/**
 * Diagnóstico Cloudflare do TIGU via GitHub Actions, ESTRITAMENTE somente-leitura.
 * Requer CLOUDFLARE_AUDIT_TOKEN em Actions Secrets e CLOUDFLARE_ACCOUNT_ID em
 * Actions Variables, definidos exclusivamente no repositório TIGU.
 * Executa apenas GET em endpoints fixos da API oficial. Não lista dados
 * de clientes, não consulta linhas D1, não lê objetos R2, não publica nem altera.
 */
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const API = "https://api.cloudflare.com/client/v4";
const ID = /^[0-9a-f]{32}$/i;
const isObject = x => Boolean(x && typeof x === "object" && !Array.isArray(x));

export async function inspectCloudflare({ token, accountId, fetcher = fetch }) {
  if (!token || typeof token !== "string" || token.length < 15)
    throw Error("Secret CLOUDFLARE_AUDIT_TOKEN ausente ou inválido no GitHub Actions.");
  if (typeof accountId !== "string" || !ID.test(accountId))
    throw Error("Variable CLOUDFLARE_ACCOUNT_ID ausente ou inválida: são 32 dígitos hexadecimais.");
  const auth = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  async function get(path) {
    // A API Cloudflare pode ter interrupções de rede transitórias.
    // Repetir SOMENTE GET (jamais operações com efeitos colaterais).
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetcher(API + path, {
          method: "GET", headers: auth, redirect: "error",
          signal: AbortSignal.timeout(20_000),
        });
        if (response.ok || ![429,502,503,504].includes(response.status) || attempt === 1) break;
      } catch (e) {
        if (attempt === 1) throw Error("Cloudflare indisponível após duas consultas de leitura.");
      }
    }
    if (!response) throw Error("Diagnóstico Cloudflare não recebeu resposta.");
    if (!response.ok)
      throw Error(`Cloudflare negou consulta (${response.status}) em ${path.split("?")[0].split("/").slice(-2).join("/")}. Confira permissões do token e Account ID.`);
    let body;
    try { body = await response.json(); }
    catch { throw Error("Cloudflare respondeu JSON inválido; diagnóstico interrompido."); }
    if (!isObject(body) || body.success !== true)
      throw Error("Cloudflare recusou uma consulta; confira escopo e acesso à conta.");
    return body.result;
  }

  const tokenStatus = await get("/user/tokens/verify");
  if (!isObject(tokenStatus) || tokenStatus.status !== "active")
    throw Error("Token Cloudflare não está ativo.");
  const base = `/accounts/${accountId}`;
  // Não consultar registros da base nem arquivos do bucket. Somente metadados.
  const d1 = await get(base + "/d1/database?name=tigu-staging-db");
  const buckets = await get(base + "/r2/buckets?name_contains=tigu-staging-media");
  const scripts = await get(base + "/workers/scripts");

  if (!Array.isArray(d1) || !isObject(buckets) || !Array.isArray(buckets.buckets) || !Array.isArray(scripts))
    throw Error("Formato de resposta Cloudflare inesperado; não declarar acesso verificado.");

  const matchesD1 = d1.filter(x => x?.name === "tigu-staging-db");
  const matchesR2 = buckets.buckets.filter(x => x?.name === "tigu-staging-media");
  const matchesWorkers = scripts.filter(x => x?.id === "tigu-staging");
  const report = {
    token_status: "active",
    account_api: "reachable",
    access: { d1: "verified", r2: "verified", workers: "verified" },
    staging_resources: {
      worker: matchesWorkers.length === 1,
      d1: matchesD1.length === 1,
      r2: matchesR2.length === 1,
    },
    // Não imprimir IDs internos, outros recursos da conta ou segredos.
    remote_changes: false,
    staging_homologated: false,
    backups_restored_and_verified: false,
  };
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = await inspectCloudflare({
      token: process.env.CLOUDFLARE_AUDIT_TOKEN,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
    });
    console.log("TIGU — diagnóstico Cloudflare somente-leitura:");
    console.log(JSON.stringify(report, null, 2));
    console.log("Nenhum deploy, migração, backup, cobrança ou modificação remota foi realizado.");
  } catch (error) {
    console.error("Diagnóstico Cloudflare não aprovado:", error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
