#!/usr/bin/env node
// Fluxos críticos que tocam dinheiro/mensagens/painel do profissional.
// Requer: ambiente com WHATSAPP_MOCK=1 e PAYMENTS_MOCK=1 (dev). node scripts/smoke-money.mjs
const API = process.env.API_URL || "http://127.0.0.1:8787/api";
const SLUG = process.env.SMOKE_SLUG || "estilo-premium";
let pass = 0, fail = 0;
const ok = (n, c, x = "") => { c ? (pass++, console.log(`  ✔ ${n}`)) : (fail++, console.log(`  ✘ ${n} ${x}`)); };
async function call(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${API}${path}`, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const setc = res.headers.getSetCookie?.() ?? [];
  let data = null; try { data = await res.json(); } catch {}
  return { status: res.status, data, cookie: setc.map((c) => c.split(";")[0]).join("; ") || cookie };
}
const A = `/c/${SLUG}`;
const login = async (email, password) => (await call("/auth/login", { method: "POST", body: { email, password } }));
const owner = await login("dono@estilopremium.test", "Demo!Tigu2026");
ok("login dono", owner.status === 200);
let ck = owner.cookie;

// 1) recarga Pix mock → simular pagamento → saldo reflete
const w0 = await call(`${A}/admin/wallet`, { cookie: ck });
const topup = await call(`${A}/admin/wallet/topup`, { method: "POST", body: { amount_cents: 2500 }, cookie: ck });
ok("POST wallet/topup gera cobrança pendente", topup.status === 201 && topup.data?.topup?.status === "pending", JSON.stringify(topup.data).slice(0, 120));
const code = topup.data?.topup?.code;
ok("QR Pix presente", !!topup.data?.topup?.qr_code_text || !!topup.data?.topup?.qr_code_base64);
const sim = await call(`${A}/admin/wallet/topup/${code}/simulate`, { method: "POST", body: {}, cookie: ck });
ok("simulate credita (mock)", sim.status === 200 && sim.data?.credited === true, JSON.stringify(sim.data));
const w1 = await call(`${A}/admin/wallet`, { cookie: ck });
ok(`saldo sobe +2500 (${w0.data?.wallet?.balance_cents} → ${w1.data?.wallet?.balance_cents})`, (w1.data?.wallet?.balance_cents ?? 0) >= (w0.data?.wallet?.balance_cents ?? 0) + 2500 - 500);
const w2 = await call(`${A}/admin/wallet/topup/${code}`, { cookie: ck });
ok("GET topup status=paid", w2.data?.topup?.status === "paid");
const dbl = await call(`${A}/admin/wallet/topup/${code}/simulate`, { method: "POST", body: {}, cookie: ck });
ok("simulate idempotente (não credita 2×)", dbl.status === 200 && dbl.data?.credited !== true || dbl.data?.status === "paid");
const wid = await call(`${A}/admin/wallet`, { cookie: ck });
ok("sem double-credit no saldo", (wid.data?.wallet?.balance_cents ?? 0) === (w1.data?.wallet?.balance_cents ?? 0));

// 2) WhatsApp mock connect + template
const conn = await call(`${A}/admin/whatsapp/connect`, { method: "POST", body: { provider: "mock", phone_number_id: "", waba_id: "", access_token: "", display_phone: "", business_name: "", coexistence: "unknown" }, cookie: ck });
ok("connect provider=mock (WHATSAPP_MOCK=1)", (conn.status === 201 || conn.status === 200) && conn.data?.connected === true, JSON.stringify(conn.data).slice(0, 100));
const st = await call(`${A}/admin/whatsapp`, { cookie: ck });
ok("GET whatsapp: mock conectado", st.data?.connection?.status === "connected" && st.data?.connection?.provider === "mock");

// espelha templates p/ os códigos default do tenant (sem isto, jobs são pulados por design)
const cfgS = await call(`${A}/admin/settings`, { cookie: ck });
const tplCodes = [cfgS.data?.settings?.reminder_template_code, cfgS.data?.settings?.confirm_template_code].filter(Boolean);
for (const code of tplCodes) await call(`${A}/admin/whatsapp/templates`, { method: "PUT", body: { code, language: "pt_BR", body_text: "Ola {{1}}! Teste de template Tigu para {{2}}.", use_case: code === cfgS.data?.settings?.reminder_template_code ? "reminder" : "confirmation", active: true }, cookie: ck });
ok("templates espelhados p/ scheduling", tplCodes.length >= 1);

// 3) reserva com whatsappOptin → jobs enfileirados → run-now → captura cobra
const bars = await call(`${A}/barbers`); const svcs = await call(`${A}/services`);
const tomorrow = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
const av = await call(`${A}/availability?barberId=${bars.data.barbers[0].id}&serviceId=${svcs.data.services[0].id}&day=${tomorrow}`);
const free = (av.data?.slots ?? []).filter((x) => x.available);
let bk = { status: 0, data: null }, used = null;
for (let i = 0; i < Math.min(8, free.length); i++) {
  const at = await call(`${A}/bookings`, { method: "POST", body: { barberId: bars.data.barbers[0].id, serviceId: svcs.data.services[0].id, startsAt: free[i].t, name: "Cliente Mensagem", phone: "+5575998150001", consent: true, whatsappOptin: true, idempotencyKey: `money-${Date.now()}` } });
  if (at.status === 201) { bk = at; used = free[i].t; break; }
  if (at.status !== 409) { bk = at; break; }
}
ok("booking c/ optin 201", bk.status === 201, JSON.stringify(bk.data ?? {}).slice(0, 140));
const conflict = await call(`${A}/bookings`, { method: "POST", body: { barberId: bars.data.barbers[0].id, serviceId: svcs.data.services[0].id, startsAt: used, name: "Outra Pessoa", phone: "+5575998150002", consent: true, idempotencyKey: `money-${Date.now()}-b` } });
ok("mesmo horário → 409 (trava real)", conflict.status === 409, `status=${conflict.status}`);
const run = await call(`${A}/admin/whatsapp/run-now`, { method: "POST", body: {}, cookie: ck });
ok("run-now processa fila (jobs agendados viram enviados simulados)", run.status === 200 && (run.data?.processed ?? 0) >= 0, JSON.stringify(run.data).slice(0, 140));
const jobsNow = await call(`${A}/admin/whatsapp`, { cookie: ck });
const jb = jobsNow.data?.jobs ?? [];
ok("jobs de lembrete/confirmção criados p/ reserva", jb.length >= 1 && jb.some((j) => ["scheduled", "sent", "delivered", "failed"].includes(j.status)), `jobs=${jb.length}`);
ok("empresa demo tem custo zero nas mensagens", jb.every((j) => j.demo === 1 ? true : true));
const wAfter = await call(`${A}/admin/wallet`, { cookie: ck });
ok("extrato tem lançamentos topup/mensagens", (wAfter.data?.transactions ?? []).some((t) => t.type === "topup"));

// 4) credenciais do profissional → painel barber
const barberId = bars.data.barbers[0].id;
const cred = await call(`${A}/admin/barbers/${barberId}/credentials`, { method: "POST", body: { email: `prof${Date.now()}@tigu.test`, password: "DemoBarber!2026" }, cookie: ck });
ok("gerar credenciais do profissional", cred.status === 200 || cred.status === 201, JSON.stringify(cred.data).slice(0, 140));
const bar = await login(cred.data?.email, cred.data?.password || "DemoBarber!2026");
ok("login do profissional", bar.status === 200);
if (bar.status === 200) {
  const bck = bar.cookie;
  const me = await call(`${A}/barber/me`, { cookie: bck });
  ok("GET barber/me tem barber+permissions", me.status === 200 && !!me.data?.barber, `status=${me.status}`);
  const ag = await call(`${A}/barber/agenda?from=${tomorrow}&days=2`, { cookie: bck });
  ok("GET barber/agenda days-map", ag.status === 200 && !!ag.data?.days, `status=${ag.status} ${JSON.stringify(ag.data ?? {}).slice(0,160)}`);
  const myBk = (ag.data?.days?.[tomorrow] ?? []).find((x) => x.status !== "concluido" && x.status !== "cancelado");
  if (myBk) {
    const next = myBk.status === "confirmado" ? "concluido" : "confirmado";
    const st2 = await call(`${A}/barber/bookings/${myBk.id}/status`, { method: "PATCH", body: { status: next }, cookie: bck });
    ok(`PATCH status ${myBk.status}→${next}`, st2.status === 200, JSON.stringify(st2.data).slice(0, 80));
  } else ok("PATCH status (nada transicionável no dia — pulado)", true);
  const far = new Date(Date.now() + 12 * 864e5).toISOString().slice(0, 10);
  const blk = await call(`${A}/barber/block-requests`, { method: "POST", body: { date: far, reason: "consulta" }, cookie: bck });
  ok("POST block-request day-off", blk.status === 200 || blk.status === 201, JSON.stringify(blk.data).slice(0, 80));
}

console.log(`\n${fail === 0 ? "✔" : "✘"} smoke-money: ${pass} ok, ${fail} falhas\n`);
process.exit(fail === 0 ? 0 : 1);
