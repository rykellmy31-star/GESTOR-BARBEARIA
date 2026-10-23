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
  assert.doesNotMatch(gate[0], /vars\.TIGU_STAGING_URL != ''/);
  assert.match(gate[0], /STAGING_URL: \$\{\{ vars\.TIGU_STAGING_URL \|\| 'https:\/\/tigu-staging\.netssh3-0\.workers\.dev' \}\}/);
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

test("Actions: deploy staging exige commit unico, branch TIGU e somente o script preflight",()=>{
  const gate=content.match(/      - name: Publicar Worker TIGU staging isolado \(commit unico\)[\s\S]*?run: node scripts\/staging-deploy-ci\.mjs/);
  assert.ok(gate,"Gate de deploy TIGU ausente");
  assert.match(gate[0],/github\.event_name == 'push'/);
  assert.match(gate[0],/github\.ref == 'refs\/heads\/audit\/tigu-primeira-validacao'/);
  assert.match(gate[0],/github\.event\.head_commit\.message == 'TIGU_DEPLOY_STAGING_ONCE'/);
  assert.match(gate[0],/CLOUDFLARE_STAGING_TOKEN: \$\{\{ secrets\.CLOUDFLARE_STAGING_TOKEN \}\}/);
  assert.match(gate[0],/TIGU_STAGING_DEPLOY_APPROVED: YES/);
  assert.doesNotMatch(gate[0],/run: wrangler deploy|npm run deploy|--remote|secret put/);
  const deploy=readFileSync(new URL("./staging-deploy-ci.mjs",import.meta.url),"utf8");
  assert.match(deploy,/stagingConfigIssues\(cfg, production\)/);
  assert.match(deploy,/TIGU_STAGING_DEPLOY_APPROVED !== "YES"/);
  assert.match(deploy,/GITHUB_EVENT_NAME !== "push"/);
  assert.match(deploy,/randomBytes\(48\)/);
  assert.match(deploy,/scripts\/staging\.mjs","migrate"/);
  assert.match(deploy,/scripts\/staging\.mjs","deploy"/);
  assert.doesNotMatch(deploy,/tigu-platform.*deploy|DELETE|payments\.create/);
});

test("Actions: exportação real D1 homologação só no commit e sem publicação do SQL",()=>{
  const gate=content.match(/      - name: Exportar D1 staging e validar restauração SQLite efêmera \(commit único\)[\s\S]*?run: node scripts\/staging-d1-export-verify\.mjs/);
  assert.ok(gate,"Gate de exportação D1 ausente");
  assert.match(gate[0],/github\.event_name == 'push'/);
  assert.match(gate[0],/github\.ref == 'refs\/heads\/audit\/tigu-primeira-validacao'/);
  assert.match(gate[0],/github\.event\.head_commit\.message == 'TIGU_VERIFY_D1_EXPORT_ONCE'/);
  assert.match(gate[0],/CLOUDFLARE_STAGING_TOKEN: \$\{\{ secrets\.CLOUDFLARE_STAGING_TOKEN \}\}/);
  assert.match(gate[0],/TIGU_D1_EXPORT_APPROVED: YES/);
  assert.doesNotMatch(gate[0],/upload-artifact|actions\/upload|wrangler d1 execute|deploy|import/);
  const src=readFileSync(new URL("./staging-d1-export-verify.mjs",import.meta.url),"utf8");
  assert.match(src,/const DATABASE="tigu-staging-db"/);
  assert.match(src,/const WORKER="tigu-staging"/);
  assert.match(src,/auditD1Export\(sql\)/);
  assert.match(src,/rmSync\(temp,\{recursive:true,force:true\}\)/);
  assert.match(src,/cloudflare_restore_verified:false/);
});

test("Actions: jornadas autenticadas só no worker staging após CI e com commit único",()=>{
  const gate=content.match(/      - name: Exercitar jornadas autenticadas remotas fictícias \(commit único\)[\s\S]*?run: node scripts\/staging-auth-e2e\.mjs/);
  assert.ok(gate,"Homologação remota autenticada sem gate");
  assert.match(gate[0],/github\.event_name == 'push'/);
  assert.match(gate[0],/github\.ref == 'refs\/heads\/audit\/tigu-primeira-validacao'/);
  assert.match(gate[0],/github\.event\.head_commit\.message == 'TIGU_AUTH_STAGING_E2E_ONCE'/);
  assert.match(gate[0],/STAGING_URL: https:\/\/tigu-staging\.netssh3-0\.workers\.dev\//);
  assert.match(gate[0],/TIGU_AUTH_E2E_APPROVED: YES/);
  assert.match(gate[0],/github\.event\.head_commit\.message == 'TIGU_ALL_STAGING_TESTS_ONCE'/);
  assert.doesNotMatch(gate[0],/CLOUDFLARE_STAGING_TOKEN|wrangler deploy|production/);
  const script=readFileSync(new URL("./staging-auth-e2e.mjs",import.meta.url),"utf8");
  assert.match(script,/isIsolatedHealth\(health\.data\)/);
  assert.match(script,/TIGU_AUTH_E2E_APPROVED\s*!==\s*"YES"/);
  assert.match(script,/tigu-staging\\\./);
  assert.doesNotMatch(script,/mercadopago\.com|graph\.facebook\.com|api\.whatsapp\.com/);
});

test("Actions: restore D1/R2 remotos exigem commit único, staging e secrets",()=>{
  for(const [title,marker,script,gateVar] of [
    ["Recuperar D1 Cloudflare em banco separado","TIGU_D1_REMOTE_RESTORE_ONCE","staging-d1-remote-restore.mjs","TIGU_REMOTE_D1_RESTORE_APPROVED"],
    ["Recuperar objeto R2 em bucket separado","TIGU_R2_REMOTE_RESTORE_ONCE","staging-r2-remote-restore.mjs","TIGU_REMOTE_R2_RESTORE_APPROVED"]
  ]){
    const at=content.indexOf("      - name: "+title);
    assert.ok(at>=0,"Gate restore ausente: "+title);
    const gate=content.slice(at,content.indexOf("\n        run: node scripts/"+script,at)+80);
    assert.ok(gate.includes("github.event_name == 'push'"));
    assert.ok(gate.includes("github.ref == 'refs/heads/audit/tigu-primeira-validacao'"));
    assert.ok(gate.includes("github.event.head_commit.message == '"+marker+"'"));
    assert.ok(gate.includes("github.event.head_commit.message == 'TIGU_ALL_STAGING_TESTS_ONCE'"));
    assert.ok(gate.includes("secrets.CLOUDFLARE_STAGING_TOKEN"));
    assert.ok(gate.includes(gateVar+": YES"));
    assert.ok(gate.includes("run: node scripts/"+script));
    const src=readFileSync(new URL("./"+script,import.meta.url),"utf8");
    assert.ok(src.includes('GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"'));
    assert.ok(src.includes(gateVar+'!=="YES"'));
    assert.doesNotMatch(src,/tigu-db(?!-)|tigu-platform|wrangler deploy|r2 object delete/i);
  }
});

test("Actions: atualizar somente Worker staging por commit explicito e sem rotacao de secret",()=>{
 const gate=content.match(/      - name: Atualizar Worker staging preservando segredos \(commit único\)[\s\S]*?run: node scripts\/staging-update-ci\.mjs/);
 assert.ok(gate,"gate update Worker ausente");
 assert.match(gate[0],/github\.event_name == 'push'/);
 assert.match(gate[0],/github\.ref == 'refs\/heads\/audit\/tigu-primeira-validacao'/);
 assert.match(gate[0],/github\.event\.head_commit\.message == 'TIGU_UPDATE_WORKER_STAGING_ONCE'/);
 assert.match(gate[0],/CLOUDFLARE_STAGING_TOKEN: \$\{\{ secrets\.CLOUDFLARE_STAGING_TOKEN \}\}/);
 const code=readFileSync(new URL("./staging-update-ci.mjs",import.meta.url),"utf8");
 assert.match(code,/TIGU_STAGING_UPDATE_APPROVED!=="YES"/);
 assert.match(code,/get\(base\+"\/workers\/scripts"\)/);
 assert.match(code,/config\.vars\.TIGU_STAGING!=="1"/);
 assert.doesNotMatch(code,/secret","put"|scripts\/staging\.mjs","migrate"|r2 object|d1 export/);
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

test("CI: preflight da futura produção somente GET e sem Worker/dados/DNS mutados",()=>{
  const part=content.match(/      - name: Inspecionar isolamento da futura produção TIGU \(somente leitura\)[\s\S]*?run: node scripts\/production-inventory-readonly\.mjs/);
  assert.ok(part,"Gate de pré-inspeção remota de produção ausente");
  assert.match(part[0],/github\.event_name == 'push'/);
  assert.match(part[0],/github\.ref == 'refs\/heads\/audit\/tigu-primeira-validacao'/);
  assert.match(part[0],/github\.event\.head_commit\.message == 'TIGU_PRODUCTION_READONLY_PREFLIGHT_ONCE'/);
  assert.match(part[0],/TIGU_PRODUCTION_READONLY_APPROVED: YES/);
  assert.match(part[0],/secrets\.CLOUDFLARE_STAGING_TOKEN/);
  const script=readFileSync(new URL("./production-inventory-readonly.mjs",import.meta.url),"utf8");
  assert.match(script,/method:"GET"/);
  assert.doesNotMatch(script,/method:"(?:POST|PUT|PATCH|DELETE)"|wrangler deploy|wrangler d1 migrations apply|secret put|r2 object put/);
  const config=JSON.parse(readFileSync(new URL("../wrangler.production.template.jsonc",import.meta.url),"utf8"));
  assert.equal(config.name,"tigu-production");
  assert.equal(config.vars.TIGU_STAGING,"0");
  assert.equal(config.vars.WHATSAPP_MOCK,"0");
  assert.equal(config.vars.PAYMENTS_MOCK,"0");
  assert.deepEqual(config.triggers.crons,[]);
  assert.equal(config.d1_databases[0].database_name,"tigu-production-db");
  assert.equal(config.r2_buckets[0].bucket_name,"tigu-production-media");
});

test("API TIGU: credenciais presentes no staging não habilitam Pix nem mensagens reais",()=>{
 const pay=readFileSync(new URL("../api/lib/payments.ts",import.meta.url),"utf8");
 const whatsapp=readFileSync(new URL("../api/lib/messaging/provider.ts",import.meta.url),"utf8");
 const webhooks=readFileSync(new URL("../api/routes/webhooks.ts",import.meta.url),"utf8");
 const smoke=readFileSync(new URL("./staging-smoke.mjs",import.meta.url),"utf8");
 assert.match(pay,/if \(env\.TIGU_STAGING === "1"\) return \{ provider: null/);
 assert.match(pay,/if \(env\.TIGU_STAGING === "1"\) return \{ ok: false/);
 assert.match(whatsapp,/if \(ctx\.env\.TIGU_STAGING === "1"\) return \{ accepted: false/);
 assert.match(webhooks,/webhooksRouter\.post\("\/mercadopago",[\s\S]*?TIGU_STAGING === "1"/);
 assert.match(webhooks,/webhooksRouter\.post\("\/whatsapp",[\s\S]*?TIGU_STAGING === "1"/);
 assert.match(smoke,/typeof health\.body\?\.payments\?\.mercadopago === "boolean"/);
 assert.match(smoke,/health\.body\?\.payments\?\.mock === false/);
 assert.match(smoke,/health\.body\?\.whatsapp\?\.mock === true/);
});

test("OAuth Marketplace mantém credenciais de vendedor isoladas dos recebimentos TIGU",()=>{
 const source=readFileSync(new URL("../api/routes/barber.ts",import.meta.url),"utf8");
 const env=readFileSync(new URL("../api/types.ts",import.meta.url),"utf8");
 assert.match(env,/MP_MARKETPLACE_CLIENT_ID\?: string/);
 assert.match(env,/MP_MARKETPLACE_CLIENT_SECRET\?: string/);
 assert.match(env,/MP_MARKETPLACE_REDIRECT_URI\?: string/);
 assert.match(source,/barberRouter\.get\("\/mercadopago"/);
 assert.match(source,/app_configured: configured/);
 assert.match(source,/connected: Boolean\(account\)/);
 assert.match(source,/can_connect: sellerOauthEnabled\(c.env\)/);
 assert.doesNotMatch(source.slice(source.indexOf('barberRouter.get("/mercadopago"'),source.indexOf('barberRouter.get("/me"')),/MP_ACCESS_TOKEN|secret\s*:/);
});

test("OAuth Marketplace bloqueia URL inválida, parâmetros ambíguos e callbacks no staging",()=>{
 const oauth=readFileSync(new URL("../api/lib/seller-mercadopago-oauth.ts",import.meta.url),"utf8");
 assert.match(oauth,/env\.TIGU_STAGING==="1"/);
 assert.match(oauth,/env\.APP_ENV!=="production"/);
 assert.match(oauth,/publicUrl\.protocol!=="https:"/);
 assert.match(oauth,/getAll\("state"\)\.length!==1/);
 assert.match(oauth,/getAll\("code"\)\.length>1/);
 assert.match(oauth,/state!==cookieState/);
 assert.match(oauth,/if\(stateCookies\.length!==1\)/);
 assert.match(oauth,/used_at IS NULL/);
 assert.match(oauth,/code_verifier:verifier/);
 assert.doesNotMatch(oauth,/MP_ACCESS_TOKEN/);
});

test("Mercado Pago individual recusa tokens malformados e desconexão respeita empresa",()=>{
 const oauth=readFileSync(new URL("../api/lib/seller-mercadopago-oauth.ts",import.meta.url),"utf8");
 const barber=readFileSync(new URL("../api/routes/barber.ts",import.meta.url),"utf8");
 assert.match(oauth,/Number\.isSafeInteger\(tokens\.expires_in\)/);
 assert.match(oauth,/Number\.isSafeInteger\(tokens\.user_id\)/);
 assert.match(oauth,/tokens\.access_token\.length>8192/);
 assert.match(oauth,/tokens\.refresh_token\.length>8192/);
 assert.match(oauth,/tokens\.expires_in>31536000/);
 const disconnect=barber.slice(barber.indexOf('barberRouter.post("/mercadopago/disconnect"'),barber.indexOf('barberRouter.get("/me"'));
 assert.match(disconnect,/company_id=\?1 AND barber_id=\?2/);
 assert.match(disconnect,/\.bind\(companyId, m\.barber_id\)/);
 assert.match(disconnect,/TIGU_STAGING === "1"/);
 assert.match(disconnect,/DELETE FROM seller_mp_oauth_pending WHERE company_id=\?1 AND barber_id=\?2/);
 assert.doesNotMatch(disconnect,/seller_mp_oauth_pending WHERE[^\n]*user_id/);
 assert.doesNotMatch(disconnect,/MP_ACCESS_TOKEN/);
});

test("callback OAuth não restaura conta após desconexão concorrente",()=>{
 const oauth=readFileSync(new URL("../api/lib/seller-mercadopago-oauth.ts",import.meta.url),"utf8");
 assert.match(oauth,/INSERT INTO seller_mp_accounts[\s\S]*?WHERE EXISTS \(SELECT 1 FROM seller_mp_oauth_pending/);
 assert.match(oauth,/state_hash=\?9 AND company_id=\?1 AND barber_id=\?2/);
 assert.match(oauth,/if\(saved\.meta\.changes!==1\)return response\(pending\.slug,"failed"\)/);
});

test("Inventário Cloudflare permite despacho manual explicitamente autorizado, nunca PR",()=>{
 const yml=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
 assert.match(yml,/production_readonly_inventory:\s*\n\s*description:[^\n]*\n\s*required: false\s*\n\s*type: boolean\s*\n\s*default: false/);
 const section=yml.slice(yml.indexOf("- name: Inspecionar isolamento da futura produção TIGU"),yml.indexOf("- name: Criar D1 e R2 novos para produção TIGU"));
 assert.match(section,/github\.event_name == 'workflow_dispatch'/);
 assert.match(section,/github\.ref == 'refs\/heads\/audit\/tigu-primeira-validacao'/);
 assert.match(section,/inputs\.production_readonly_inventory == true/);
 assert.doesNotMatch(section,/github\.event_name == 'pull_request'/);
 assert.match(section,/run: node scripts\/production-inventory-readonly\.mjs/);
});
