#!/usr/bin/env node
// ============================================================================
// Sobe a barbearia de DEMONSTÇÃO da Tigu via API local (requer `npm run dev:api`
// + migrações aplicadas). Idempotente: reuso a empresa se já existir.
//   node scripts/setup-demo.mjs
//   API_URL=… TIGU_SUPER_EMAIL=… TIGU_SUPER_PASSWORD=… node scripts/setup-demo.mjs
// ============================================================================
const API = process.env.API_URL || "http://127.0.0.1:8787/api";
const SUPER_EMAIL = (process.env.TIGU_SUPER_EMAIL || "super@tigu.app").toLowerCase();
const SUPER_PASS = process.env.TIGU_SUPER_PASSWORD;

async function req(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    redirect: "manual",
  });
  const setc = res.headers.getSetCookie?.() ?? [];
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { res, data, cookie: setc.map((c) => c.split(";")[0]).join("; ") || cookie };
}

const login = await req("/auth/login", { method: "POST", body: { email: SUPER_EMAIL, password: SUPER_PASS } });
if (login.res.status === 401 && !SUPER_PASS) {
  console.error("✘ Sem TIGU_SUPER_PASSWORD e o login falhou. Rode antes: npm run setup:super (anote a senha) e exporte TIGU_SUPER_PASSWORD=…");
  process.exit(1);
}
if (!login.data?.user) { console.error("✘ login superadmin falhou:", login.res.status, JSON.stringify(login.data)); process.exit(1); }
let cookie = login.cookie;

const cos = await req("/super/companies", { cookie });
const slug = "estilo-premium";
let co = (cos.data?.companies ?? []).find((c) => c.slug === slug);
if (!co) {
  const created = await req("/super/companies", { method: "POST", cookie, body: {
    name: "Barbearia Estilo Premium (demo)", slug, plan_code: "pro",
    owner_email: "dono@estilopremium.test", owner_name: "Seu Dono", owner_password: "Demo!Tigu2026",
  } });
  if (created.res.status >= 400) { console.error("✘ criar empresa:", created.res.status, JSON.stringify(created.data)); process.exit(1); }
  co = { id: created.data.id, slug: created.data.slug };
  cookie = created.cookie || cookie;
}
const seed = await req(`/super/companies/${co.id}/seed-demo`, { method: "POST", cookie });
if (!seed.res.ok) { console.error("✘ seed-demo:", seed.res.status, JSON.stringify(seed.data)); process.exit(1); }

console.log(`
✔ Demo pronta (empresa id=${co.id}, created=${seed.data.created} registros fictícios demo=1)

  Site:      /c/${co.slug}
  Agendar:   /c/${co.slug}/agendar
  Painel:    /c/${co.slug}/admin        → dono@estilopremium.test / Demo!Tigu2026
  Painel do profissional (barbeiro demo criado no painel › Equipe › credenciais)
  Suíte:     /superadmin                → ${SUPER_EMAIL} / (sua senha de setup:super)

  Dica: ative WHATSAPP_MOCK=1 no .dev.vars para brincar de "conectar" WhatsApp em simulação.`);
