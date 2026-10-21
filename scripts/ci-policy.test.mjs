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


test("Actions: token Cloudflare apenas na etapa opcional e com diagnostico GET sem mutacoes", () => {
  const gate = content.match(/      - name: Diagnosticar acesso Cloudflare por token \(se configurado\)[\s\S]*?run: node scripts\/cloudflare-audit\.mjs/);
  assert.ok(gate, "Etapa Cloudflare por token ausente");
  assert.match(gate[0], /github\.event_name == 'push'/);
  assert.match(gate[0], /github\.ref == 'refs\/heads\/audit\/tigu-primeira-validacao'/);
  assert.doesNotMatch(gate[0], /vars\.CLOUDFLARE_ACCOUNT_ID != ''/);
  assert.match(gate[0], /CLOUDFLARE_AUDIT_TOKEN: \$\{\{ secrets\.CLOUDFLARE_AUDIT_TOKEN \}\}/);
  assert.match(gate[0], /CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \|\| secrets\.CLOUDFLARE_ACCOUNT_ID \}\}/);
  const diagnostic = readFileSync(new URL("./cloudflare-audit.mjs", import.meta.url), "utf8");
  assert.match(diagnostic, /method: "GET"/);
  assert.doesNotMatch(diagnostic, /method: "(?:POST|PUT|PATCH|DELETE)"/);
  assert.doesNotMatch(diagnostic, /wrangler deploy|migrations apply|d1 execute|R2\.put/);
});

test("Actions: cria D1/R2 somente em push do commit TIGU explicitamente autorizado", () => {
  const gate = content.match(/      - name: Provisionar D1 e R2 isolados do TIGU \(commit unico\)[\s\S]*?run: node scripts\/staging-provision\.mjs create/);
  assert.ok(gate, "Gate de provisionamento TIGU ausente");
  assert.match(gate[0], /github\.event_name == 'push'/);
  assert.match(gate[0], /github\.ref == 'refs\/heads\/audit\/tigu-primeira-validacao'/);
  assert.match(gate[0], /github\.event\.head_commit\.message == 'TIGU_PROVISION_STAGING_ONCE'/);
  assert.match(gate[0], /CLOUDFLARE_STAGING_TOKEN: \$\{\{ secrets\.CLOUDFLARE_STAGING_TOKEN \}\}/);
  assert.match(gate[0], /TIGU_STAGING_CREATE_APPROVED: YES/);
  assert.doesNotMatch(gate[0], /wrangler|staging:deploy|--remote|terraform|curl|deploy/);
  const provision = readFileSync(new URL("./staging-provision.mjs",import.meta.url), "utf8");
  assert.match(provision, /const D1_NAME = "tigu-staging-db"/);
  assert.match(provision, /const R2_NAME = "tigu-staging-media"/);
  assert.match(provision, /allowedPOST = new Set\(\[prefix \+ "\/d1\/database", prefix \+ "\/r2\/buckets"\]\)/);
  assert.doesNotMatch(provision, /method: "DELETE"|method: "PUT"|method: "PATCH"|wrangler deploy/);
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


test("Painel Equipe interpreta dias já normalizados e mantém serviços vinculados", () => {
  const frontend = readFileSync(new URL("../src/pages/admin/BarbersPage.tsx", import.meta.url), "utf8");
  const backend = readFileSync(new URL("../api/routes/admin.ts", import.meta.url), "utf8");
  assert.match(frontend, /Array\.isArray\(b\.work_days\)/);
  assert.doesNotMatch(frontend, /JSON\.parse\(b\.work_days/);
  const route = backend.split('adminRouter.get("/barbers"')[1]?.split('adminRouter.post("/barbers"')[0] ?? "";
  assert.match(route, /service_ids: byBarber\.get\(Number\(b\.id\)\)/);
  assert.match(route, /WHERE b\.company_id=\?1/);
  assert.match(route, /work_days: safeArr/);
});


test("Valor personalizado é o mesmo enviado à API, sem cobranças quando gateway estiver ausente",()=>{
  const src=readFileSync(new URL("../src/pages/admin/WalletPage.tsx",import.meta.url),"utf8");
  assert.match(src,/create\.mutate\(selected\)/);
  assert.match(src,/amount_cents: cents/);
  assert.match(src,/parseTopupAmountCents\(custom\)/);
  assert.match(src,/!d\.payments_available \|\| create\.isPending/);
  assert.match(src,/topup_limits/);
  assert.doesNotMatch(src,/amount_cents: amount/);
});


test("Pix real não pode ser cancelado apenas no banco local",()=>{
  const api=readFileSync(new URL("../api/routes/admin.ts",import.meta.url),"utf8");
  const topup=readFileSync(new URL("../api/lib/topup.ts",import.meta.url),"utf8");
  const ui=readFileSync(new URL("../src/pages/admin/WalletPage.tsx",import.meta.url),"utf8");
  const cancelRoute=api.split('adminRouter.post("/wallet/topup/:code/cancel"')[1]?.split("\n});")[0]??"";
  assert.match(cancelRoute,/topup\.provider !== "mock"/);
  assert.match(topup,/status IN \('pending','expired','cancelled'\)/);
  assert.match(topup,/t\.status === "cancelled" && t\.provider === "mercadopago"/);
  assert.match(ui,/checkout\.provider === "mock"/);
});


test("CI roda Chromium real local e dashboard trata indisponibilidade",()=>{
  const ci=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
  const smoke=readFileSync(new URL("../scripts/browser-smoke.mjs",import.meta.url),"utf8");
  const dashboard=readFileSync(new URL("../src/pages/admin/DashboardPage.tsx",import.meta.url),"utf8");
  assert.match(ci,/node scripts\/browser-smoke\.mjs/);
  assert.match(smoke,/TIGU_STAGING:\s*"1"/);
  assert.match(smoke,/--headless=new/);
  assert.match(smoke,/Page\.navigate/);
  assert.match(smoke,/Runtime\.evaluate/);
  assert.match(dashboard,/q\.isError \|\| !q\.data/);
});


test("Reserva no Chromium percorre assistente e valida acesso individual do profissional",()=>{
  const s=readFileSync(new URL("../scripts/browser-smoke.mjs",import.meta.url),"utf8");
  const publicForm=readFileSync(new URL("../src/pages/public/BookingPage.tsx",import.meta.url),"utf8");
  const pro=readFileSync(new URL("../src/pages/barber/BarberPanelPage.tsx",import.meta.url),"utf8");
  assert.match(s,/visitante agenda serviço e profissional pela interface real/);
  assert.match(s,/profissional precisa trocar senha provisória no navegador/);
  assert.match(s,/acesso individual do profissional após troca obrigatória/);
  assert.match(publicForm,/localDay\(tz\)\.slice\(0, 7\)/);
  assert.match(pro,/me\.isError \|\| agenda\.isError/);
});


test("Consulta pública e cancelamento exigem confirmação com bloqueio de envio duplicado",()=>{
  const booking=readFileSync(new URL("../src/pages/public/MyBookingsPage.tsx",import.meta.url),"utf8");
  const dialog=readFileSync(new URL("../src/components/ui/index.tsx",import.meta.url),"utf8");
  const browser=readFileSync(new URL("../scripts/browser-smoke.mjs",import.meta.url),"utf8");
  assert.match(booking,/if \(!cancelTarget \|\| cancelBusy\) return/);
  assert.match(booking,/busy=\{cancelBusy\}/);
  assert.match(dialog,/disabled=\{busy\} onClick=\{onConfirm\}/);
  assert.match(browser,/cliente remarca reserva para horário livre pela interface/);
  assert.match(browser,/cliente cancela reserva pela confirmação e libera horário/);
});


test("Bloqueios e Superadmin são exercitados no Chromium com proteção de envio",()=>{
  const smoke=readFileSync(new URL("../scripts/browser-smoke.mjs",import.meta.url),"utf8");
  const agenda=readFileSync(new URL("../src/pages/admin/AgendaPage.tsx",import.meta.url),"utf8");
  const companies=readFileSync(new URL("../src/pages/super/CompaniesPage.tsx",import.meta.url),"utf8");
  assert.match(smoke,/profissional solicita bloqueio sem alterar a agenda sozinho/);
  assert.match(smoke,/proprietário aprova bloqueio e retira intervalo da agenda/);
  assert.match(smoke,/Superadmin cadastra empresa e dono com teste grátis, sem cobrança/);
  assert.match(agenda,/disabled=\{acting !== null\}/);
  assert.match(agenda,/q\.isError/);
  assert.match(companies,/list\.isError/);
});


test("Visão geral Superadmin usa texto monetário e evita [object Object]",()=>{
  const overview=readFileSync(new URL("../src/pages/super/OverviewPage.tsx",import.meta.url),"utf8");
  const smoke=readFileSync(new URL("../scripts/browser-smoke.mjs",import.meta.url),"utf8");
  assert.match(overview,/money0\(d\.topups\.cents\)/);
  assert.doesNotMatch(overview,/\$\{<Money cents=\{d\.topups\.cents\}/);
  assert.match(smoke,/BARBEARIAS ATIVAS/);
});


test("Superadmin abre detalhe correto, ajusta créditos no D1 e não exibe regras desativadas",()=>{
  const detail=readFileSync(new URL("../src/pages/super/CompanyDetailPage.tsx",import.meta.url),"utf8");
  const pricing=readFileSync(new URL("../src/pages/super/PricingPage.tsx",import.meta.url),"utf8");
  const route=readFileSync(new URL("../api/routes/super.ts",import.meta.url),"utf8");
  const browser=readFileSync(new URL("../scripts/browser-smoke.mjs",import.meta.url),"utf8");
  assert.match(detail,/to="\/superadmin\/companies"/);
  assert.match(detail,/q\.isError \|\| !q\.data/);
  assert.match(pricing,/q\.isError \|\| !q\.data/);
  assert.match(route,/FROM pricing_rules pr LEFT JOIN companies c ON c.id=pr.company_id WHERE pr.active=1/);
  assert.match(browser,/Superadmin faz ajuste financeiro auditável apenas na carteira local/);
  assert.match(browser,/Superadmin consulta mensalidades sem ativação ou cobrança/);
});
