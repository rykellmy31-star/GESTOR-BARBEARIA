import test from "node:test";
import assert from "node:assert/strict";
import { inspectCloudflare } from "./cloudflare-audit.mjs";

const accountId = "1234567890abcdef1234567890abcdef";
const token = "token-ficticio-tigu-diagnostico-123456789";
const base = "https://api.cloudflare.com/client/v4";
const good = {
  "/user/tokens/verify": { success: true, result: { status: "active" } },
  [`/accounts/${accountId}/d1/database?name=tigu-staging-db`]: {
    success: true, result: [{ name: "tigu-staging-db", uuid: "NUNCA_PUBLICAR" }],
  },
  [`/accounts/${accountId}/r2/buckets?name_contains=tigu-staging-media`]: {
    success: true, result: { buckets: [{ name: "tigu-staging-media" }] },
  },
  [`/accounts/${accountId}/workers/scripts`]: {
    success: true, result: [{ id: "tigu-staging" }],
  },
};
function fake(responses = good, requests = []) {
  return async (url, options) => {
    requests.push({ url, options });
    const resource = url.replace(base, "");
    const data = responses[resource];
    if (!data) throw Error("Rota inesperada: " + resource);
    return { ok: true, status: 200, json: async () => data };
  };
}

test("consulta EXCLUSIVAMENTE GET aos quatro endpoints oficiais e não divulga IDs", async () => {
  const requests = [];
  const report = await inspectCloudflare({ token, accountId, fetcher: fake(good, requests) });
  assert.equal(requests.length, 4);
  assert.deepEqual(report.access, { d1: "verified", r2: "verified", workers: "verified" });
  assert.deepEqual(report.staging_resources, { worker: true, d1: true, r2: true });
  assert.equal(report.staging_homologated, false);
  assert.equal(report.backups_restored_and_verified, false);
  assert.equal(report.remote_changes, false);
  assert.ok(!JSON.stringify(report).includes(token));
  assert.ok(!JSON.stringify(report).includes(accountId));
  assert.ok(!JSON.stringify(report).includes("NUNCA_PUBLICAR"));
  for (const { url, options } of requests) {
    assert.ok(url.startsWith(base));
    assert.equal(options.method, "GET");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${token}`);
  }
});

test("não trata ausência de recursos como homologação; ainda confirma permissões de leitura", async () => {
  const empty = structuredClone(good);
  empty[`/accounts/${accountId}/d1/database?name=tigu-staging-db`].result = [];
  empty[`/accounts/${accountId}/r2/buckets?name_contains=tigu-staging-media`].result.buckets = [];
  empty[`/accounts/${accountId}/workers/scripts`].result = [];
  const result = await inspectCloudflare({ token, accountId, fetcher: fake(empty) });
  assert.deepEqual(result.staging_resources, { worker: false, d1: false, r2: false });
  assert.equal(result.account_api, "reachable");
});

test("recusa token ausente, Account ID inválido e token desativado sem requisições indevidas", async () => {
  const requests = [];
  await assert.rejects(inspectCloudflare({ token: "", accountId, fetcher: fake(good, requests) }), /Secret/);
  await assert.rejects(inspectCloudflare({ token, accountId: "ID_INVALIDO", fetcher: fake(good, requests) }), /CLOUDFLARE_ACCOUNT_ID/);
  assert.equal(requests.length, 0);
  const revoked = structuredClone(good);
  revoked["/user/tokens/verify"].result.status = "disabled";
  await assert.rejects(inspectCloudflare({ token, accountId, fetcher: fake(revoked, requests) }), /não está ativo/);
  assert.equal(requests.length, 1);
});

test("falha fechado se Cloudflare negar acesso D1, R2 ou Workers", async () => {
  for (const suffix of ["/d1/database?name=tigu-staging-db", "/r2/buckets?name_contains=tigu-staging-media", "/workers/scripts"]) {
    const fetcher = async (url, options) => {
      const path = url.replace(base, "");
      if (path.endsWith(suffix)) return { ok: false, status: 403 };
      return fake()(url, options);
    };
    await assert.rejects(inspectCloudflare({ token, accountId, fetcher }), /negou consulta \(403\)/);
  }
});

test("não considera respostas malformadas como acesso confirmado", async () => {
  const malformed = structuredClone(good);
  malformed[`/accounts/${accountId}/r2/buckets?name_contains=tigu-staging-media`].result = {};
  await assert.rejects(inspectCloudflare({ token, accountId, fetcher: fake(malformed) }), /Formato/);
});
