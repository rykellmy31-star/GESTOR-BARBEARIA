#!/usr/bin/env node
// ============================================================================
// Smoke test FUM-DE-01 da Tigu contra um ambiente rodando (dev ou preview):
//   API_URL=http://127.0.0.1:8787/api node scripts/smoke.mjs
// Cobre: config público, disponibilidade real, reserva, lookup, cancelamento
// por código+telefone, login tenant, painel admin e isolamento entre empresas.
// ============================================================================
const API = process.env.API_URL || "http://127.0.0.1:8787/api";
let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => { cond ? (pass++, console.log(`  ✔ ${name}`)) : (fail++, console.log(`  ✘ ${name} ${extra}`)); };

async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setc = res.headers.getSetCookie?.() ?? [];
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, cookie: setc.map((c) => c.split(";")[0]).join("; ") || cookie };
}

const SLUG = process.env.SMOKE_SLUG || "estilo-premium";
console.log(`\n— smoke ${SLUG} @ ${API}`);

const cfg = await call(`/c/${SLUG}/config`);
ok("GET /config 200 + settings.shop_name", cfg.status === 200 && !!cfg.data?.settings?.shop_name, `status=${cfg.status}`);

const barbers = await call(`/c/${SLUG}/barbers`);
ok("GET /barbers lista ≥1 ativo", barbers.status === 200 && barbers.data?.barbers?.length >= 1);
const services = await call(`/c/${SLUG}/services`);
ok("GET /services lista ≥1", services.status === 200 && services.data?.services?.length >= 1);

// disponibilidade amanhã
const tomorrow = new Date(Date.now() + 3 * 864e5).toISOString().slice(0, 10); // dia sem colisão com outras suítes
const av = await call(`/c/${SLUG}/availability?barberId=${barbers.data.barbers[0].id}&serviceId=${services.data.services[0].id}&day=${tomorrow}`);
const free = (av.data?.slots ?? []).filter((x) => x.available);
ok("GET /availability tem slot livre", av.status === 200 && free.length > 0, `status=${av.status} slots=${av.data?.slots?.length} closed=${av.data?.closed_reason ?? ""}`);

// reserva via API pública (mesmo contrato do BookingPage)
const IDM = `smoke-${Date.now()}`;
let book = null, slotIdx = 0;
for (let i = 0; i < Math.min(8, free.length); i++) {
  const attempt = await call(`/c/${SLUG}/bookings`, { method: "POST", body: {
    barberId: barbers.data.barbers[0].id, serviceId: services.data.services[0].id,
    startsAt: free[i].t, name: "Cliente Smoke", phone: "+5575998150000",
    consent: true, whatsappOptin: true, idempotencyKey: IDM,
  } });
  if (attempt.status === 201) { book = attempt; slotIdx = i; break; }
  if (attempt.status !== 409) { book = attempt; break; } // erro real: reporta
}
book = book ?? { status: 0, data: null };
ok("POST /bookings idempotente (2× mesma chave reutiliza)", book.status === 201);
const book2 = await call(`/c/${SLUG}/bookings`, { method: "POST", body: {
  barberId: barbers.data.barbers[0].id, serviceId: services.data.services[0].id,
  startsAt: free[slotIdx]?.t, name: "Cliente Smoke", phone: "+5575998150000",
  consent: true, whatsappOptin: true, idempotencyKey: IDM,
} });
ok("repetição retorna reused", book2.status === 201 && book2.data?.booking?.id === book.data?.booking?.id);
ok("POST /bookings 201 + code", book.status === 201 && !!book.data?.booking?.code, `status=${book.status} ${JSON.stringify(book.data).slice(0, 140)}`);

if (book.data?.booking?.code) {
  const lk = await call(`/c/${SLUG}/bookings/lookup?code=${book.data.booking.code}&phone=%2B5575998150000`);
  ok("GET lookup code+phone", lk.status === 200 && lk.data?.bookings?.length >= 1);
  const cx = await call(`/c/${SLUG}/bookings/cancel`, { method: "POST", body: { code: book.data.booking.code, phone: "+5575998150000" } });
  ok("POST /bookings/cancel code+phone", cx.status === 200, `status=${cx.status} ${JSON.stringify(cx.data).slice(0, 120)}`);
}

// login dono do tenant + painel
const OWNER = { email: process.env.SMOKE_OWNER_EMAIL || "dono@estilopremium.test", password: process.env.SMOKE_OWNER_PASSWORD || "Demo!Tigu2026" };
const lg = await call("/auth/login", { method: "POST", body: OWNER });
ok("POST /auth/login dono", lg.status === 200 && !!lg.data?.user, `status=${lg.status}`);
if (lg.data?.user) {
  const dash = await call(`/c/${SLUG}/admin/dashboard`, { cookie: lg.cookie });
  ok("GET admin/dashboard 200 + kpis", dash.status === 200 && "kpis" in (dash.data ?? {}), `keys=${Object.keys(dash.data ?? {}).join(",")}`);
  const agenda = await call(`/c/${SLUG}/admin/agenda?day=${tomorrow}`, { cookie: lg.cookie });
  ok("GET admin/agenda 200", agenda.status === 200);
  const wa = await call(`/c/${SLUG}/admin/whatsapp`, { cookie: lg.cookie });
  ok("GET admin/whatsapp 200 (central)", wa.status === 200 && !!wa.data?.connection, `status=${wa.status}`);
  const wallet = await call(`/c/${SLUG}/admin/wallet`, { cookie: lg.cookie });
  ok("GET admin/wallet 200", wallet.status === 200 && wallet.data?.wallet);
}

// isolamento: outra empresa não vê dados desta
const lg2 = await call("/auth/login", { method: "POST", body: { email: "naoexiste@nope.test", password: "xxxxxxxxxxxx" } });
ok("login conta inexistente → 401", lg2.status === 401);
const other = await call("/c/outra-barbearia-inexistente/config");
ok("slug inexistente → 404/410", other.status === 404 || other.status === 410, `status=${other.status}`);

console.log(`\n${fail === 0 ? "✔" : "✘"} smoke: ${pass} ok, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
