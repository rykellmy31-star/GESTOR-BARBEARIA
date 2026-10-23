#!/usr/bin/env node
/**
 * Diagnóstico REMOTO de homologação, estritamente somente-leitura.
 *
 * STAGING_URL=https://tigu-staging.SUA_SUBCONTA.workers.dev npm run staging:smoke
 *
 * Não usa cookies, senhas, dados de clientes nem executa POST/PUT/PATCH/DELETE.
 * Falha antes dos demais testes se o endpoint NÃO identificar o Worker isolado.
 */
import process from "node:process";

const raw = process.env.STAGING_URL;
if (!raw) {
  console.error("Informe STAGING_URL=https://tigu-staging.SUA_SUBCONTA.workers.dev (Worker de homologação).");
  process.exit(1);
}
let url;
try { url = new URL(raw); } catch {
  console.error("STAGING_URL inválida.");
  process.exit(1);
}
const remote = /^tigu-staging\.[a-z0-9-]+\.workers\.dev$/i.test(url.hostname) &&
  url.protocol === "https:";
const local = ["127.0.0.1", "localhost"].includes(url.hostname) &&
  url.protocol === "http:" && url.port === "8787";
if ((!remote && !local) || url.username || url.password || url.search || url.hash ||
    !["", "/"].includes(url.pathname)) {
  console.error("Por segurança, STAGING_URL deve ser apenas a raiz de tigu-staging.<sub>.workers.dev ou localhost:8787.");
  process.exit(1);
}
const base = url.origin;
let passed = 0;
const pass = (name) => { passed++; console.log("✔ " + name); };
const fail = (name, detail) => {
  console.error("✘ " + name + (detail ? ": " + detail : ""));
  process.exitCode = 1;
};
async function get(path) {
  const response = await fetch(base + path, {
    method: "GET", redirect: "manual", signal: AbortSignal.timeout(10_000),
    headers: { "accept": "application/json", "cache-control": "no-store" },
  });
  let body = null;
  try { body = await response.json(); } catch { /* HTML or malformed response */ }
  return { status: response.status, body };
}
function assert(name, condition, detail = "") {
  if (condition) pass(name);
  else fail(name, detail);
}

console.log("Diagnóstico Tigu isolado em " + base);
try {
  const health = await get("/api/health");
  const isolated = health.status === 200 && health.body?.ok === true &&
    health.body?.service === "tigu-api" && health.body?.staging === true &&
    health.body?.d1 === true && health.body?.r2 === true &&
    health.body?.security?.session_secret_ready === true &&
    health.body?.security?.encryption_key_ready === true &&
    // O indicador mercadopago/embedded relata PRESENÇA de credencial,
    // não permissão de transacionar. TIGU_STAGING=1 continua recusando
    // Pix real, webhooks de pagamento e envio de mensagens Meta.
    health.body?.payments?.mock === false &&
    typeof health.body?.payments?.mercadopago === "boolean" &&
    health.body?.whatsapp?.mock === true &&
    typeof health.body?.whatsapp?.embedded === "boolean";

  if (!isolated) {
    fail("VERIFICAÇÃO DE IDENTIDADE: Worker isolado, D1, R2, secrets fortes e integrações",
      "o ambiente não passou pelo contrato de segurança. Nada mais foi consultado.");
    process.exit(1);
  }
  pass("Worker de homologação e recursos isolados (sem Pix/Meta reais)");

  const plans = await get("/api/marketing/plans");
  assert("Planos comerciais no D1", plans.status === 200 &&
    Array.isArray(plans.body?.plans) &&
    plans.body.plans.map(p => p.code).join(",") === "free,pro,scale" &&
    plans.body.automatic_billing === false);

  const contact = await get("/api/marketing/contact");
  assert("Contato comercial público sem erro", contact.status === 200 &&
    contact.body?.contact && typeof contact.body.contact.enabled === "boolean");

  const challenge = await get("/api/marketing/lead-config");
  assert("Turnstile exigido em homologação",
    challenge.status === 200 && challenge.body?.required === true &&
    (challenge.body.enabled === false || typeof challenge.body.site_key === "string"));

  const anonymous = await get("/api/auth/me");
  assert("Sessão anônima sem acesso", anonymous.status === 200 &&
    anonymous.body?.user === null);

  const leads = await get("/api/super/leads");
  assert("Dados comerciais protegidos contra visitantes", leads.status === 401);

  console.log(`\n${passed} verificações concluídas. ${process.exitCode ? "Revisar falhas." : "Ambiente pronto para testes MANUAIS com contas fictícias."}`);
} catch (error) {
  fail("Consulta ao Worker", error instanceof Error ? error.message : String(error));
}
