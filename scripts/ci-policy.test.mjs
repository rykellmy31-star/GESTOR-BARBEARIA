import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const content = workflow.replace(/^\s*#.*$/gm, "");
const events = content.split(/^on:\s*$/m)[1]?.split(/^permissions:/m)[0];

test("Actions: eventos permitidos apenas na branch de auditoria, PR para main e manual", () => {
  assert.ok(events, "Declaracao de eventos obrigatoria");
  const keys = [...events.matchAll(/^  ([a-z_]+):/gm)].map(m => m[1]);
  assert.deepEqual(keys, ["push", "pull_request", "workflow_dispatch"]);
  assert.match(events, /^  push:\s*\n    branches:\s*\n      - audit\/tigu-primeira-validacao\s*$/m);
  assert.match(events, /^  pull_request:\s*\n    branches:\s*\n      - main\s*$/m);
  assert.doesNotMatch(events, /^  (schedule|workflow_run|repository_dispatch|pull_request_target):/m);
});

test("Actions: permissao de leitura e validacao sem deploy ou migracoes remotas", () => {
  assert.match(content, /^permissions:\s*\n  contents: read\s*$/m);
  assert.match(content, /^  verificar:\s*$/m);
  assert.match(content, /run: npm ci/);
  assert.match(content, /run: npm run validate/);
  assert.doesNotMatch(content, /run:\s*[^\n]*(?:wrangler deploy|--remote|staging:deploy|npm run deploy)/i);
  assert.match(content, /run: node scripts\/local-e2e\.mjs/);

});

test("Actions: verificacao online opcional, somente leitura e limitada a staging", () => {
  const gate = content.match(/  - name: Conferir homologacao Cloudflare online \(se configurada\)[\s\S]*?run: node scripts\/staging-smoke\.mjs/);
  assert.ok(gate, "Etapa de verificacao remota ausente");
  assert.match(gate[0], /github\.event_name == 'push'/);
  assert.match(gate[0], /github\.ref == 'refs\/heads\/audit\/tigu-primeira-validacao'/);
  assert.match(gate[0], /vars\.TIGU_STAGING_URL != ''/);
  assert.match(gate[0], /STAGING_URL: \$\{\{ vars\.TIGU_STAGING_URL \}\}/);
  assert.doesNotMatch(gate[0], /secrets\.|wrangler|deploy|--remote|npm run/);
  const diagnostic = readFileSync(new URL("./staging-smoke.mjs", import.meta.url), "utf8");
  assert.match(diagnostic, /redirect: "manual"/);
  assert.match(diagnostic, /method: "GET"/);
  assert.match(diagnostic, /tigu-staging/);
  assert.doesNotMatch(diagnostic, /method: "POST"|method: "DELETE"|method: "PUT"|method: "PATCH"/);
});


test("Painéis: consultas sensíveis usam cache separado por barbearia", () => {
  const cases = {
    "ServicesPage.tsx": ['"admin-services", siteBase()', '"admin-barbers", siteBase()'],
    "BarbersPage.tsx": ['"admin-barbers", siteBase()', '"admin-services", siteBase()'],
    "TeamPage.tsx": ['"team", siteBase()', '"admin-barbers", siteBase()'],
    "AgendaPage.tsx": ['"agenda", siteBase()', '"blocked-days", siteBase()', '"block-requests", siteBase()'],
    "OrdersPage.tsx": ['"orders", siteBase()'],
    "CustomersPage.tsx": ['"customers", siteBase()', '"customer", siteBase()'],
    "DashboardPage.tsx": ['"dashboard", siteBase()'],
    "SettingsPage.tsx": ['"admin-settings", siteBase()', '"audit", siteBase()'],
  };
  for (const [file, expected] of Object.entries(cases)) {
    const src = readFileSync(new URL("../src/pages/admin/" + file, import.meta.url), "utf8");
    for (const key of expected) assert.ok(src.includes(key), file + " sem isolamento: " + key);
  }
  for (const file of ["ServicesPage.tsx", "BarbersPage.tsx"]) {
    const src = readFileSync(new URL("../src/pages/admin/" + file, import.meta.url), "utf8");
    assert.match(src, /invalidateQueries\(\{ queryKey: \["tenant", siteBase\(\), "services"\] \}\)/);
  }
});

test("Cliente: remarcação seleciona dia e pesquisa protocolo sem expor telefone na URL", () => {
  const src = readFileSync(new URL("../src/pages/public/MyBookingsPage.tsx", import.meta.url), "utf8");
  assert.match(src, /api\.post<\{bookings: any\[\]\}>\("\/bookings\/lookup"/);
  assert.doesNotMatch(src, /\/bookings\/lookup\?code=/);
  assert.match(src, /type="date" value=\{reschedDate\} min=\{today\} max=\{maxReschedDay\}/);
  assert.match(src, /slotsLoading \? <Spinner/);
  assert.match(src, /Sem horários disponíveis nessa data/);
});
