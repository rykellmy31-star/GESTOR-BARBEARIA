import { applyBookingMigrations } from "./helpers/booking-migrations";
// ============================================================================
// Regras críticas da Tigu (runtime real do Workers via vitest-pool-workers):
// fuso/grade, catálogo por empresa, disponibilidade, trava de conflito,
// idempotência, cancelamento público com liberação do slot, bloqueio pela
// barbearia e ISOLAMENTO multi-tenant (RBAC no servidor).
// ============================================================================
/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import type { Env } from "../api/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
import schema0001 from "../migrations/0001_init.sql";
import schema0002 from "../migrations/0002_whatsapp_identity.sql";
import schema0003 from "../migrations/0003_sales_leads.sql";
import schema0004 from "../migrations/0004_start_trial.sql";
import schema0005 from "../migrations/0005_subscription_pix.sql";
import schema0006 from "../migrations/0006_request_rate_limits.sql";
import schema0007 from "../migrations/0007_last_superadmin_guard.sql";
import schema0008 from "../migrations/0008_booking_overlap_guard.sql";
import schema0103 from "../migrations/0103_manual_platform_subscriptions.sql";
import { hashPassword } from "../api/lib/crypto";
import { localToUtc, utcToLocal, tzOffsetMinutes } from "../api/lib/time";
import { slotKeysFor } from "../api/lib/availability";
import { planAllowsAutomaticWhatsapp, scheduleBookingMessage, cancelPendingJobs, processDueJobs } from "../api/lib/messaging/jobs";
import { resolveProvider } from "../api/lib/messaging/provider";
import { mpProvider, pickPaymentProvider } from "../api/lib/payments";
import { app } from "../api/index";
import { loadCompanySettings } from "../api/lib/settings";
import { resolveApiUrl } from "../api/lib/url";
import { purgeExpiredSalesLeads, purgeOldSalesRateLimits, getSalesRetentionDays } from "../api/lib/sales-leads";
import { reconcilePendingTopups } from "../api/lib/topup";
import { manualAdjustment, creditTopup, reserveForJob, releaseJobReservation, captureJobCharge, refundJobCharge, getWallet, resolveUncertainNotSent } from "../api/lib/wallet";

const db = env.DB as unknown as D1Database;

async function runSqlScript(sql: string): Promise<void> {
  const statements = sql.replace(/--[^\n]*/g, "").split(";").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50).map((s) => db.prepare(s)));
}

const PW = "SenhaForte#2026!";
let cookieA = "", cookieB = "";

async function api(path: string, init: RequestInit = {}, cookie?: string) {
  const headers: Record<string, string> = { "content-type": "application/json", ...(init.headers as Record<string, string>) };
  if (cookie) headers.cookie = cookie;
  const res = await SELF.fetch(`http://local.test${path}`, { ...init, headers });
  const text = await res.text();
  let body: any = null; try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  const setc = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { status: res.status, body, cookie: setc || undefined };
}

function nextWorkday(offsetDays = 1): string {
  let d = new Date(Date.now() + offsetDays * 864e5);
  for (let i = 0; i < 10; i++) {
    const iso = d.toISOString().slice(0, 10);
    const wd = new Date(`${iso}T12:00:00Z`).getUTCDay();
    if (wd >= 1 && wd <= 5) return iso;
    d = new Date(d.getTime() + 864e5);
  }
  return d.toISOString().slice(0, 10);
}

beforeAll(async () => {
  await runSqlScript(schema0001);
  await runSqlScript(schema0002);
  await runSqlScript(schema0003);
  await runSqlScript(schema0004);
  await runSqlScript(schema0005);
  await runSqlScript(schema0006);
  // Tabelas aditivas de solicitação de plano e renovação manual da plataforma.
  await runSqlScript(schema0103);
  // Migrações com triggers precisam preservar BEGIN/END como um único comando.
  for(const script of [schema0007,schema0008])
    for(const trigger of script.match(/CREATE TRIGGER[\s\S]+?END;/g)!) await db.prepare(trigger).run();
  const hash = await hashPassword(PW);
  const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  await db.batch([
    db.prepare(`INSERT INTO users (platform_role,name,email,password_hash,active,created_at) VALUES ('user','Dono A','dono@a.test',?1,1,?2)`).bind(hash, now),
    db.prepare(`INSERT INTO users (platform_role,name,email,password_hash,active,created_at) VALUES ('user','Dono B','dono@b.test',?1,1,?2)`).bind(hash, now),
    db.prepare(`INSERT INTO companies (slug,name,status,plan_code,created_at,updated_at) VALUES ('alfa','Barbearia Alfa','active','pro',?1,?1)`).bind(now),
    db.prepare(`INSERT INTO companies (slug,name,status,plan_code,created_at,updated_at) VALUES ('bravo','Barbearia Bravo','active','free',?1,?1)`).bind(now),
  ]);
  const { results: cos } = await db.prepare(`SELECT id, slug FROM companies ORDER BY id`).all<{ id: number; slug: string }>();
  const a = cos[0].id, b = cos[1].id;
  const { results: us } = await db.prepare(`SELECT id, email FROM users ORDER BY id`).all<{ id: number; email: string }>();
  const ua = us.find((u) => u.email === "dono@a.test")!.id, ub = us.find((u) => u.email === "dono@b.test")!.id;
  await db.batch([
    db.prepare(`INSERT INTO company_settings (company_id,data,updated_at) VALUES (?1,'{"timezone":"America/Bahia","currency":"BRL","slot_min":15,"horizon_days":30}',?2)`).bind(a, now),
    db.prepare(`INSERT INTO company_settings (company_id,data,updated_at) VALUES (?1,'{"timezone":"America/Bahia","currency":"BRL","slot_min":15,"horizon_days":30}',?2)`).bind(b, now),
    db.prepare(`INSERT INTO company_memberships (company_id,user_id,role,active,created_at) VALUES (?1,?2,'owner',1,?3)`).bind(a, ua, now),
    db.prepare(`INSERT INTO company_memberships (company_id,user_id,role,active,created_at) VALUES (?1,?2,'owner',1,?3)`).bind(b, ub, now),
    db.prepare(`INSERT INTO subscriptions (company_id,plan_code,status,period_end,updated_at) VALUES (?1,'pro','active',strftime('%Y-%m-%dT%H:%M:%SZ',?2,'+30 days'),?2)`).bind(a, now),
    db.prepare(`INSERT INTO wallets (company_id,updated_at) VALUES (?1,?2)`).bind(a, now),
    db.prepare(`INSERT INTO barbers (company_id,slug,name,specialty,work_days,work_start,work_end,break_start,break_end,active,sort,created_at)
                VALUES (?1,'zeca','Zeca','Fade','[1,2,3,4,5]','09:00','18:00','12:00','13:00',1,0,?2)`).bind(a, now),
    db.prepare(`INSERT INTO services (company_id,slug,name,price_cents,duration_min,active,show_in_catalog,created_at) VALUES (?1,'corte','Corte',4500,30,1,1,?2)`).bind(a, now),
    db.prepare(`INSERT INTO barbers (company_id,slug,name,specialty,work_days,work_start,work_end,break_start,break_end,active,sort,created_at)
                VALUES (?1,'beth','Beth','Barba','[1,2,3,4,5]','09:00','18:00','12:00','13:00',1,0,?2)`).bind(b, now),
    db.prepare(`INSERT INTO services (company_id,slug,name,price_cents,duration_min,active,show_in_catalog,created_at) VALUES (?1,'corte-b','Corte B',6000,30,1,1,?2)`).bind(b, now),
  ]);
  const { results: links } = await db.prepare(`SELECT s.id sid, br.id bid, s.company_id cid FROM services s JOIN barbers br ON br.company_id=s.company_id ORDER BY s.id, br.id`).all<{ sid: number; bid: number; cid: number }>();
  for (const l of links) await db.prepare(`INSERT OR IGNORE INTO service_barbers (service_id,barber_id) VALUES (?1,?2)`).bind(l.sid, l.bid).run();
  // Simulador exclusivamente nos testes. Conexão Meta antiga nunca é usada.
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO whatsapp_connections (company_id,provider,status,phone_number_id) VALUES (?1,'mock','connected','mock-Alfa')").bind(a),
    db.prepare("INSERT OR IGNORE INTO whatsapp_connections (company_id,provider,status,phone_number_id) VALUES (?1,'mock','connected','mock-Bravo')").bind(b),
  ]);
  const la = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "dono@a.test", password: PW }) });
  const lb = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "dono@b.test", password: PW }) });
  cookieA = la.cookie ?? ""; cookieB = lb.cookie ?? "";
  expect(la.status).toBe(200);
  await applyBookingMigrations(db);
});

describe("fuso horário e grade", () => {
  it("tzOffsetMinutes America/Bahia = -180 (sem DST)", () => {
    expect(tzOffsetMinutes("America/Bahia", new Date("2026-01-15T12:00:00Z"))).toBe(-180);
    expect(tzOffsetMinutes("America/Bahia", new Date("2026-07-15T12:00:00Z"))).toBe(-180);
  });
  it("localToUtc/utcToLocal são inversos", () => {
    const d = new Date(localToUtc("America/Bahia", "2026-03-10", 9 * 60 + 15).getTime());
    expect(d.toISOString()).toBe("2026-03-10T12:15:00.000Z");
    expect(utcToLocal("America/Bahia", d)).toMatchObject({ day: "2026-03-10", minutes: 9 * 60 + 15, weekday: 2 });
  });
  it("slotKeys cobre 30min com passo 15 => 2 chaves", () => {
    expect(slotKeysFor("2026-03-10T12:15:00Z", "2026-03-10T12:45:00Z", 15).length).toBe(2);
  });
});

describe("catálogo isolado por empresa", () => {
  it("GET /c/alfa/barbers só mostra os da Alfa", async () => {
    const r = await api("/api/c/alfa/barbers");
    expect(r.status).toBe(200);
    expect(r.body.barbers.map((x: any) => x.name)).toEqual(["Zeca"]);
  });
  it("GET /c/bravo/services não vaza serviço da Alfa", async () => {
    const r = await api("/api/c/bravo/services");
    expect(r.body.services.every((x: any) => x.name === "Corte B")).toBe(true);
  });
  it("slug inexistente → 404", async () => {
    expect((await api("/api/c/charlie/config")).status).toBe(404);
  });
});

describe("disponibilidade & reserva", () => {
  const day = nextWorkday(1);
  it("grade do dia tem slots, almoço fica indisponível", async () => {
    const r = await api(`/api/c/alfa/availability?barberId=1&serviceId=1&day=${day}`);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.slots.length).toBeGreaterThan(4);
    const atLunch = r.body.slots.find((x: any) => x.label === "12:00");
    if (atLunch) expect(atLunch.available).toBe(false);
  });
  it("domingo está fechado", async () => {
    const r = await api(`/api/c/alfa/availability?barberId=1&serviceId=1&day=${nextWorkday(0)}&x=1`);
    expect(r.status).toBe(200);
  });
  it("reserva idempotência reutiliza a mesma reserva", async () => {
    const free = (await api(`/api/c/alfa/availability?barberId=1&serviceId=1&day=${day}`)).body.slots.filter((x: any) => x.available);
    const body = JSON.stringify({ barberId: 1, serviceId: 1, startsAt: free[0].t, name: "Ana", phone: "+5575999990001", consent: true, idempotencyKey: "k-idem-1" });
    const r1 = await api("/api/c/alfa/bookings", { method: "POST", body });
    expect(r1.status).toBe(201);
    const r2 = await api("/api/c/alfa/bookings", { method: "POST", body });
    expect(r2.status).toBe(201);
    expect(r2.body.booking.id).toBe(r1.body.booking.id);
  });
  it("mesmo horário por outro cliente → 409; cancelamento libera o slot", async () => {
    const free = (await api(`/api/c/alfa/availability?barberId=1&serviceId=1&day=${day}`)).body.slots.filter((x: any) => x.available);
    const mine = await api("/api/c/alfa/bookings", { method: "POST", body: JSON.stringify({ barberId: 1, serviceId: 1, startsAt: free[0].t, name: "Beto", phone: "+5575999990002", consent: true, idempotencyKey: `k-conflict-${Date.now()}` }) });
    expect(mine.status).toBe(201);
    const clash = await api("/api/c/alfa/bookings", { method: "POST", body: JSON.stringify({ barberId: 1, serviceId: 1, startsAt: free[0].t, name: "Cara", phone: "+5575999990003", consent: true, idempotencyKey: `k-conflict2-${Date.now()}` }) });
    expect(clash.status).toBe(409);
    // dono cancela pelo painel → slot volta
    const cx = await api(`/api/c/alfa/admin/bookings/${mine.body.booking.id}/cancel`, { method: "POST", body: JSON.stringify({ reason: "teste" }) }, cookieA);
    expect(cx.status).toBe(200);
    const free2 = (await api(`/api/c/alfa/availability?barberId=1&serviceId=1&day=${day}`)).body.slots;
    expect(free2.find((x: any) => x.t === free[0].t)?.available).toBe(true);
    const rebook = await api("/api/c/alfa/bookings", { method: "POST", body: JSON.stringify({ barberId: 1, serviceId: 1, startsAt: free[0].t, name: "De Novo", phone: "+5575999990005", consent: true, idempotencyKey: `k-rebook-${Date.now()}` }) });
    expect(rebook.status).toBe(201);
  });
});

describe("bloqueio & agenda do painel", () => {
  const day = nextWorkday(2);
  it("dono fecha o dia e a grade pública fica off", async () => {
    const bl = await api(`/api/c/alfa/admin/blocked-days`, { method: "POST", body: JSON.stringify({ date_from: day, date_to: day, reason: "feriado interno" }) }, cookieA);
    expect([200, 201]).toContain(bl.status);
    const av = await api(`/api/c/alfa/availability?barberId=1&serviceId=1&day=${day}`);
    expect(av.body.ok).toBe(false);
  });
  it("dashboard do dono responde com kpis", async () => {
    const r = await api(`/api/c/alfa/admin/dashboard?days=7`, {}, cookieA);
    expect(r.status).toBe(200);
    expect(r.body.kpis).toBeTruthy();
  });
});

describe("RBAC multi-tenant", () => {
  it("dono da Bravo NÃO acessa painel da Alfa", async () => {
    const r = await api("/api/c/alfa/admin/dashboard", {}, cookieB);
    expect([403, 404]).toContain(r.status);
  });
  it("dono da Alfa NÃO acessa agenda da Bravo", async () => {
    const r = await api("/api/c/bravo/admin/agenda", {}, cookieA);
    expect([403, 404]).toContain(r.status);
  });
  it("sem cookie → 401 no painel", async () => {
    expect((await api("/api/c/alfa/admin/wallet")).status).toBe(401);
  });
  it("super não autenticado → 401", async () => {
    expect((await api("/api/super/overview")).status).toBe(401);
  });
});

describe("carteira do Tigu: operações e cobrança sem duplicidade", () => {
  it("ajuste e Pix repetidos não criam saldo extra; reserva, captura, estorno e liberação preservam o extrato", async () => {
    const companyId = 1;
    const userId = 1;
    const initial = (await getWallet(db, companyId))!;
    const key = `financial-regression-${Date.now()}`;
    const justification = "Teste automatizado de conciliacao financeira";

    expect((await manualAdjustment(db, companyId, 5000, justification, userId, key)).ok).toBe(true);
    expect((await manualAdjustment(db, companyId, 5000, justification, userId, key)).ok).toBe(false);
    expect((await getWallet(db, companyId))!.balance_cents).toBe(initial.balance_cents + 5000);

    const insertedTopup = await db.prepare(
      `INSERT INTO topup_orders (company_id, code, amount_cents, status, provider)
       VALUES (?1, ?2, 3000, 'pending', 'mock')`
    ).bind(companyId, `TEST-${key}`).run();
    const topupId = insertedTopup.meta.last_row_id as number;
    expect(await creditTopup(db, companyId, 3000, topupId)).toBe(true);
    expect(await creditTopup(db, companyId, 3000, topupId)).toBe(false);
    expect(await creditTopup(db, companyId, 9000, topupId)).toBe(false);
    expect((await getWallet(db, companyId))!.balance_cents).toBe(initial.balance_cents + 8000);

    const makeJob = async (suffix: string, cents: number): Promise<number> => {
      const date = new Date().toISOString();
      const ins = await db.prepare(
        `INSERT INTO message_jobs
         (company_id,kind,to_phone,template_code,language,status,scheduled_at,fire_deadline,price_cents,idempotency_key)
         VALUES (?1,'test','5573999999999','tigu_test','pt_BR','scheduled',?2,?2,?3,?4)`
      ).bind(companyId, date, cents, `${key}-${suffix}`).run();
      return ins.meta.last_row_id as number;
    };

    const jobId = await makeJob("capture", 10);
    expect((await reserveForJob(db, companyId, jobId, 10, false)).ok).toBe(true);
    expect((await reserveForJob(db, companyId, jobId, 10, false)).ok).toBe(true);
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(initial.reserved_cents + 10);
    await db.prepare("UPDATE message_jobs SET status='sent' WHERE id=?1").bind(jobId).run();
    expect(await captureJobCharge(db, companyId, jobId, 10)).toBe(true);
    expect(await captureJobCharge(db, companyId, jobId, 10)).toBe(false);
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(initial.reserved_cents);
    expect((await getWallet(db, companyId))!.balance_cents).toBe(initial.balance_cents + 7990);
    expect(await refundJobCharge(db, companyId, jobId, 10)).toBe(true);
    expect(await refundJobCharge(db, companyId, jobId, 10)).toBe(false);
    expect((await getWallet(db, companyId))!.balance_cents).toBe(initial.balance_cents + 8000);

    const secondJobId = await makeJob("cancel", 150);
    expect((await reserveForJob(db, companyId, secondJobId, 150, false)).ok).toBe(true);
    await db.prepare("UPDATE message_jobs SET status='cancelled' WHERE id=?1").bind(secondJobId).run();
    expect(await releaseJobReservation(db, companyId, secondJobId, 150)).toBe(true);
    expect(await releaseJobReservation(db, companyId, secondJobId, 150)).toBe(false);
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(initial.reserved_cents);
    expect((await getWallet(db, companyId))!.balance_cents).toBe(initial.balance_cents + 8000);

    const last = await db.prepare(
      `SELECT COUNT(*) AS n FROM wallet_transactions WHERE idempotency_key IN
       (?1,?2,?3,?4,?5,?6,?7)`
    ).bind(`adjust:${key}`, `topup:${topupId}`,
      `reserve:job-${jobId}`, `capture:job-${jobId}`, `refund:job-${jobId}`,
      `reserve:job-${secondJobId}`, `release:job-${secondJobId}`).first<{ n: number }>();
    expect(last?.n).toBe(7);
  });
});

describe("lembrete de 1 hora e remarcação com isolamento da barbearia", () => {
  it("agenda exatamente 60 minutos antes, não duplica, e remarca liberando créditos", async () => {
    const companyId = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'").first<{ id: number }>())!.id;
    const barberId = (await db.prepare("SELECT id FROM barbers WHERE company_id=?1 LIMIT 1")
      .bind(companyId).first<{ id: number }>())!.id;
    const serviceId = (await db.prepare("SELECT id FROM services WHERE company_id=?1 LIMIT 1")
      .bind(companyId).first<{ id: number }>())!.id;
    const now = new Date();
    const starts = new Date(now.getTime() + 3 * 60 * 60_000);
    const ends = new Date(starts.getTime() + 30 * 60_000);
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    const booked = await db.prepare(
      `INSERT INTO bookings
        (company_id,code,barber_id,service_id,starts_at,ends_at,price_cents,
         status,origin,customer_name,customer_phone,whatsapp_optin,cancel_token)
       VALUES (?1,?2,?3,?4,?5,?6,4500,'confirmado','cliente','Teste Lembrete',
         '5573999991234',1,?7)`
    ).bind(companyId, `TIGUREM-${Date.now()}`, barberId, serviceId, iso(starts), iso(ends), `ct-${Date.now()}`).run();
    const bookingId = booked.meta.last_row_id as number;
    await db.prepare(
      `INSERT OR IGNORE INTO whatsapp_templates
       (company_id,code,language,category,status,body_text,active)
       VALUES (?1,'tigu_lembrete','pt_BR','utility','approved','Seu horário está chegando',1)`
    ).bind(companyId).run();
    await db.prepare("UPDATE whatsapp_connections SET status='connected' WHERE company_id=?1")
      .bind(companyId).run();
    await manualAdjustment(db, companyId, 1000, "Credito para testar lembretes de atendimento", 1, `reminder-${bookingId}`);
    const settings = await loadCompanySettings(db, companyId);
    const booking = {
      id: bookingId, company_id: companyId, code: `TIGUREM-${bookingId}`,
      customer_name: "Teste Lembrete", customer_phone: "5573999991234",
      whatsapp_optin: 1, barber_name: "Zeca", service_name: "Corte",
      starts_at: iso(starts), status: "confirmado"
    };
    const baseline = (await getWallet(db, companyId))!.reserved_cents;
    const first = await scheduleBookingMessage({ db, companyId, booking, settings, kind: "reminder", now });
    expect(first.ok).toBe(true);
    expect(first.status).toBe("scheduled");

    const row = await db.prepare(
      `SELECT id,scheduled_at,price_cents,reserved_cents,status FROM message_jobs
       WHERE booking_id=?1 AND kind='reminder' AND status='scheduled'`
    ).bind(bookingId).first<{ id: number; scheduled_at: string; price_cents: number; reserved_cents: number; status: string }>();
    expect(row).not.toBeNull();
    expect(Date.parse(row!.scheduled_at)).toBe(Date.parse(iso(starts)) - 60 * 60_000);
    expect(row!.price_cents).toBe(10);
    expect(row!.reserved_cents).toBe(10);
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(baseline + 10);

    const repeat = await scheduleBookingMessage({ db, companyId, booking, settings, kind: "reminder", now });
    expect(repeat.ok).toBe(true);
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(baseline + 10);
    expect((await db.prepare("SELECT COUNT(*) n FROM message_jobs WHERE booking_id=?1")
      .bind(bookingId).first<{ n: number }>())!.n).toBe(1);

    const movedStart = new Date(starts.getTime() + 60 * 60_000);
    await db.prepare("UPDATE bookings SET starts_at=?1,ends_at=?2,schedule_version=2 WHERE id=?3")
      .bind(iso(movedStart), iso(new Date(movedStart.getTime() + 30 * 60_000)), bookingId).run();
    booking.starts_at = iso(movedStart);
    const moved = await scheduleBookingMessage({ db, companyId, booking, settings, kind: "reminder", now });
    expect(moved.ok).toBe(true);
    const jobs = await db.prepare("SELECT id,status,reserved_cents FROM message_jobs WHERE booking_id=?1 ORDER BY id")
      .bind(bookingId).all<{ id: number; status: string; reserved_cents: number }>();
    expect(jobs.results.map(j => j.status)).toEqual(["cancelled", "scheduled"]);
    expect(jobs.results[0].reserved_cents).toBe(0);
    expect(jobs.results[1].reserved_cents).toBe(10);
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(baseline + 10);

    await cancelPendingJobs(db, companyId, bookingId, "reminder", "agendamento cancelado");
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(baseline);
    expect((await db.prepare("SELECT status FROM message_jobs WHERE id=?1")
      .bind(jobs.results[1].id).first<{ status: string }>())!.status).toBe("cancelled");
  });
});

describe("Pix: recuperar confirmação sem webhook", () => {
  it("reconsulta Mercado Pago e credita uma única vez, inclusive pedido expirado; rejeita valor divergente", async () => {
    const companyId = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'")
      .first<{ id: number }>())!.id;
    const before = (await getWallet(db, companyId))!.balance_cents;
    const stamp = String(Date.now());
    const when = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const pending = { id: `MP-P-${stamp}`, code: `P-${stamp}`, cents: 2500, status: "pending" };
    const expired = { id: `MP-E-${stamp}`, code: `E-${stamp}`, cents: 1000, status: "expired" };
    const bad = { id: `MP-X-${stamp}`, code: `X-${stamp}`, cents: 6000, status: "pending" };
    for (const row of [pending, expired, bad]) {
      await db.prepare(
        `INSERT INTO topup_orders
         (company_id,code,amount_cents,status,provider,provider_payment_id,created_at,updated_at)
         VALUES (?1,?2,?3,?4,'mercadopago',?5,?6,?6)`
      ).bind(companyId, row.code, row.cents, row.status, row.id, when).run();
    }
    const paymentRows = [pending, expired, bad];
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const payment = paymentRows.find(r => url.endsWith(`/v1/payments/${r.id}`));
      if (!payment) throw Error("Não deveria consultar outro endpoint");
      const payload = {
        id: payment.id, status: "approved", currency_id: "BRL",
        payment_method_id: "pix", external_reference: payment.code,
        transaction_amount: (payment.cents + (payment === bad ? 100 : 0)) / 100
      };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    const paymentEnv = {
      ...env, DB: db, MP_ACCESS_TOKEN: "testing-only",
      MP_WEBHOOK_SECRET: "testing-only-webhook-secret",
      PUBLIC_URL: "https://tigu.example.com", APP_ENV: "development",
    } as Env;
    try {
      const first = await reconcilePendingTopups(paymentEnv, 20);
      expect(first.credited).toBe(2);
      expect(first.errors).toBe(1);
      expect((await getWallet(db, companyId))!.balance_cents).toBe(before + 3500);
      const second = await reconcilePendingTopups(paymentEnv, 20);
      expect(second.credited).toBe(0);
      expect((await getWallet(db, companyId))!.balance_cents).toBe(before + 3500);
      const uncredited = await db.prepare("SELECT status,credited_at FROM topup_orders WHERE code=?1")
        .bind(bad.code).first<{ status: string; credited_at: string | null }>();
      expect(uncredited?.status).toBe("pending");
      expect(uncredited?.credited_at).toBeNull();
      expect(fetchSpy).toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});


describe("Pix de recarga: cancelamento seguro e conciliação legada",()=>{
  it("não cancela Pix real localmente, nem de outra empresa; mock pode ser cancelado",async()=>{
    const companyId=(await db.prepare("SELECT id FROM companies WHERE slug='alfa'").first<{id:number}>())!.id;
    const nonce=crypto.randomUUID().toUpperCase();
    const real="PIX-REAL-"+nonce, mock="PIX-MOCK-"+nonce;
    for(const item of [{code:real,provider:"mercadopago"},{code:mock,provider:"mock"}]){
      await db.prepare("INSERT INTO topup_orders(company_id,code,amount_cents,status,provider,provider_payment_id) VALUES (?1,?2,2500,'pending',?3,?4)")
        .bind(companyId,item.code,item.provider,item.code+"-id").run();
    }
    const path=(code:string)=>"/api/c/alfa/admin/wallet/topup/"+code+"/cancel";
    expect((await api(path(real),{method:"POST",body:"{}"},cookieA)).status).toBe(409);
    expect(await db.prepare("SELECT status FROM topup_orders WHERE code=?1").bind(real).first("status")).toBe("pending");
    expect((await api(path(real),{method:"POST",body:"{}"},cookieB)).status).toBe(403);
    expect((await api(path(mock),{method:"POST",body:"{}"},cookieA)).status).toBe(200);
    expect(await db.prepare("SELECT status FROM topup_orders WHERE code=?1").bind(mock).first("status")).toBe("cancelled");
    expect((await api(path(mock),{method:"POST",body:"{}"},cookieA)).status).toBe(409);
  });
  it("recupera Pix real cancelado no D1 apenas após comprovar pagamento íntegro no gateway",async()=>{
    const {confirmTopupFromProvider}=await import("../api/lib/topup");
    const companyId=(await db.prepare("SELECT id FROM companies WHERE slug='alfa'").first<{id:number}>())!.id;
    const before=(await getWallet(db,companyId))!.balance_cents;
    const nonce=crypto.randomUUID();
    const approved={code:"LEGACY-OK-"+nonce,id:"MP-OK-"+nonce,cents:2950};
    const mismatched={code:"LEGACY-BAD-"+nonce,id:"MP-BAD-"+nonce,cents:6000};
    for(const t of [approved,mismatched]){
      await db.prepare("INSERT INTO topup_orders(company_id,code,amount_cents,status,provider,provider_payment_id) VALUES (?1,?2,?3,'cancelled','mercadopago',?4)")
        .bind(companyId,t.code,t.cents,t.id).run();
    }
    const spy=vi.spyOn(globalThis,"fetch").mockImplementation(async(input)=>{
      const target=String(input).includes(approved.id)?approved:mismatched;
      return new Response(JSON.stringify({
        id:target.id,status:"approved",currency_id:"BRL",payment_method_id:"pix",
        external_reference:target.code,transaction_amount:(target.cents+(target===mismatched?100:0))/100
      }),{status:200,headers:{"content-type":"application/json"}});
    });
    const paymentEnv={...env,DB:db,APP_ENV:"development",TIGU_STAGING:"0",
      MP_ACCESS_TOKEN:"test-token",MP_WEBHOOK_SECRET:"test-secret",PUBLIC_URL:"https://tigu.example.com",
      PAYMENTS_MOCK:"0"} as Env;
    try{
      const bad=await confirmTopupFromProvider(paymentEnv,mismatched.id,"poll");
      expect(bad).toMatchObject({ok:false,status:"mismatch",credited:false});
      expect(await db.prepare("SELECT status FROM topup_orders WHERE code=?1").bind(mismatched.code).first("status")).toBe("cancelled");
      const first=await confirmTopupFromProvider(paymentEnv,approved.id,"poll");
      expect(first).toMatchObject({ok:true,status:"paid",credited:true});
      expect((await getWallet(db,companyId))!.balance_cents).toBe(before+approved.cents);
      const second=await confirmTopupFromProvider(paymentEnv,approved.id,"poll");
      expect(second).toMatchObject({ok:true,status:"paid",credited:false});
      expect((await getWallet(db,companyId))!.balance_cents).toBe(before+approved.cents);
      expect(await db.prepare("SELECT COUNT(*) n FROM wallet_transactions WHERE idempotency_key=?1")
        .bind("topup:"+(await db.prepare("SELECT id FROM topup_orders WHERE code=?1").bind(approved.code).first("id"))).first("n")).toBe(1);
    }finally{spy.mockRestore();}
  });
});

describe("WhatsApp: incerteza de envio nunca autoriza duplicidade", () => {
  it("não volta à fila depois que um Worker expirou em estado de envio indeterminado", async () => {
    const companyId = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'")
      .first<{ id: number }>())!.id;
    const now = new Date();
    const lastAttemptAt = new Date(now.getTime() - 12 * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const dueAt = new Date(now.getTime() - 15 * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const ins = await db.prepare(
      `INSERT INTO message_jobs (company_id, kind, to_phone, template_code,
         language, status, scheduled_at, fire_deadline, attempts, last_attempt_at,
         price_cents, reserved_cents, provider_msg_id, idempotency_key)
       VALUES (?1,'test','5573999990030','tigu_lembrete','pt_BR','sending',
         ?2,?3,1,?4,0,0,'',?5)`
    ).bind(companyId, dueAt, new Date(now.getTime() + 60 * 60000).toISOString(), lastAttemptAt, `stuck-${Date.now()}`).run();
    const jobId = ins.meta.last_row_id as number;
    const first = await processDueJobs(env as Env, { now, companyId });
    const second = await processDueJobs(env as Env, { now, companyId });
    expect(first.sent).toBe(0);
    expect(second.sent).toBe(0);
    const row = await db.prepare(
      "SELECT status, attempts, last_error FROM message_jobs WHERE id=?1"
    ).bind(jobId).first<{ status: string; attempts: number; last_error: string }>();
    expect(row?.status).toBe("sending");
    expect(row?.attempts).toBe(1);
    expect(row?.last_error).toMatch(/Pendente de conferência/);
  });
});

describe("Superadmin: conciliação de WhatsApp sem reenvio", () => {
  let superCookie = "";
  const makeUncertain = async (suffix: string) => {
    const companyId = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'")
      .first<{ id: number }>())!.id;
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const attempted = new Date(Date.now() - 12 * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const walletBefore = (await getWallet(db, companyId))!;
    const ins = await db.prepare(
      `INSERT INTO message_jobs (company_id,kind,to_phone,template_code,status,
         scheduled_at,fire_deadline,price_cents,language,idempotency_key,last_error,last_attempt_at)
       VALUES (?1,'reminder','5573999993333','tigu_lembrete','scheduled',
         ?2,?2,10,'pt_BR',?3,'',?4)`
    ).bind(companyId, now, `ops-${suffix}-${Date.now()}`, attempted).run();
    const jobId = ins.meta.last_row_id as number;
    const reserved = await reserveForJob(db, companyId, jobId, 10, false);
    expect(reserved.ok).toBe(true);
    await db.prepare(
      `UPDATE message_jobs SET status='sending',
         last_error='Envio sem confirmação do provedor: timeout',attempts=1 WHERE id=?1`
    ).bind(jobId).run();
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(walletBefore.reserved_cents + 10);
    return { companyId, jobId, walletBefore };
  };

  it("impede conta comum de encerrar mensagem, e devolve reserva sem lançar débito quando não enviada", async () => {
    const { companyId, jobId, walletBefore } = await makeUncertain("not-sent");
    const payload = { decision: "not_sent", justification: "Conferi o painel do provedor e confirmei que não enviou." };
    const forbidden = await api(`/api/super/messages/${jobId}/resolve`,
      { method: "POST", body: JSON.stringify(payload) }, cookieA);
    expect(forbidden.status).toBe(403);

    const hashed = await hashPassword(PW);
    await db.prepare(
      `INSERT INTO users(platform_role,name,email,password_hash,active)
       VALUES ('superadmin','Operador Tigu','ops@tigu.test',?1,1)`
    ).bind(hashed).run();
    const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({
      email: "ops@tigu.test", password: PW
    }) });
    expect(login.status).toBe(200);
    superCookie = login.cookie ?? "";
    expect(superCookie.length).toBeGreaterThan(0);

    const done = await api(`/api/super/messages/${jobId}/resolve`,
      { method: "POST", body: JSON.stringify(payload) }, superCookie);
    expect(done.status).toBe(200);
    expect(done.body.status).toBe("failed");
    const updated = await db.prepare(
      "SELECT status,reserved_cents,refunded_at,captured_at FROM message_jobs WHERE id=?1"
    ).bind(jobId).first<{ status: string; reserved_cents: number; refunded_at: string | null; captured_at: string | null }>();
    expect(updated?.status).toBe("failed");
    expect(updated?.reserved_cents).toBe(0);
    expect(updated?.refunded_at).not.toBeNull();
    expect(updated?.captured_at).toBeNull();
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(walletBefore.reserved_cents);
    expect((await getWallet(db, companyId))!.balance_cents).toBe(walletBefore.balance_cents);
    const repeated = await api(`/api/super/messages/${jobId}/resolve`,
      { method: "POST", body: JSON.stringify(payload) }, superCookie);
    expect(repeated.status).toBe(409);
    const auditRow = await db.prepare(
      "SELECT action FROM audit_log WHERE entity='message_job' AND entity_id=?1 AND action='message.not_sent_confirmed'"
    ).bind(String(jobId)).first<{ action: string }>();
    expect(auditRow?.action).toBe("message.not_sent_confirmed");
  });

  it("exige ID Meta único e cobra uma única vez ao confirmar envio verificado", async () => {
    const { companyId, jobId, walletBefore } = await makeUncertain("confirmed-sent");
    const bad = await api(`/api/super/messages/${jobId}/resolve`, { method: "POST", body: JSON.stringify({
      decision: "confirmed_sent", provider_message_id: "invalido",
      justification: "Mensagem confirmada manualmente no painel do provedor."
    }) }, superCookie);
    expect(bad.status).toBe(422);
    const metaId = `wamid.TiguConfirmed${jobId}Example`;
    const payload = {
      decision: "confirmed_sent", provider_message_id: metaId,
      justification: "Verifiquei o identificador no painel oficial de mensagens Meta."
    };
    const ok = await api(`/api/super/messages/${jobId}/resolve`,
      { method: "POST", body: JSON.stringify(payload) }, superCookie);
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe("sent");
    expect(ok.body.captured).toBe(true);
    const updated = await db.prepare(
      "SELECT status,provider_msg_id,captured_at,reserved_cents FROM message_jobs WHERE id=?1"
    ).bind(jobId).first<{ status: string; provider_msg_id: string; captured_at: string | null; reserved_cents: number }>();
    expect(updated?.provider_msg_id).toBe(metaId);
    expect(updated?.captured_at).not.toBeNull();
    expect(updated?.reserved_cents).toBe(0);
    expect((await getWallet(db, companyId))!.balance_cents).toBe(walletBefore.balance_cents - 10);
    expect((await getWallet(db, companyId))!.reserved_cents).toBe(walletBefore.reserved_cents);
    expect((await api(`/api/super/messages/${jobId}/resolve`,
      { method: "POST", body: JSON.stringify(payload) }, superCookie)).status).toBe(409);
    const ledger = await db.prepare(
      "SELECT COUNT(*) n FROM wallet_transactions WHERE idempotency_key=?1"
    ).bind(`capture:job-${jobId}`).first<{ n: number }>();
    expect(ledger?.n).toBe(1);
  });
});


describe("Superadmin: revisão de WhatsApp com resultado incerto", () => {
  it("não libera crédito de outra empresa; encerramento documentado é único e atômico", async () => {
    const companyA = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'")
      .first<{ id: number }>())!.id;
    const companyB = (await db.prepare("SELECT id FROM companies WHERE slug='bravo'")
      .first<{ id: number }>())!.id;
    const evidence = "Conferência manual no painel Meta: mensagem não encontrada e sem envio registrado.";
    const when = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const old = new Date(Date.now() - 12 * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const stamp = Date.now();
    const before = (await getWallet(db, companyA))!;
    expect((await manualAdjustment(db, companyA, 200, "Credito adicional para teste de conciliacao", 1, "uncertain-" + stamp)).ok).toBe(true);
    const ins = await db.prepare(
      "INSERT INTO message_jobs (company_id,kind,to_phone,template_code,status,scheduled_at,fire_deadline,price_cents,idempotency_key) VALUES (?1,'test','5573999995678','tigu_lembrete','scheduled',?2,?2,25,?3)"
    ).bind(companyA, when, "uncertain-job-" + stamp).run();
    const id = ins.meta.last_row_id as number;
    expect((await reserveForJob(db, companyA, id, 25, false)).ok).toBe(true);
    await db.prepare("UPDATE message_jobs SET status='sending',attempts=1,last_attempt_at=?1 WHERE id=?2")
      .bind(old, id).run();
    const reserved = (await getWallet(db, companyA))!.reserved_cents;
    expect(reserved).toBe(before.reserved_cents + 25);
    expect((await resolveUncertainNotSent(db, companyB, id, 1, evidence)).ok).toBe(false);
    const unauthorized = await api("/api/super/messages/" + id + "/resolve-not-sent", {
      method: "POST", body: JSON.stringify({ confirmed_not_sent: true, evidence })
    }, cookieA);
    expect(unauthorized.status).toBe(403);
    expect((await getWallet(db, companyA))!.reserved_cents).toBe(reserved);

    const done = await resolveUncertainNotSent(db, companyA, id, 1, evidence);
    expect(done.ok).toBe(true);
    expect((await resolveUncertainNotSent(db, companyA, id, 1, evidence)).ok).toBe(false);
    const retry = await api("/api/c/alfa/admin/whatsapp/jobs/" + id + "/retry", { method: "POST", body: "{}" }, cookieA);
    expect(retry.status).toBe(409); // não reabrir a cobrança após encerramento
    const after = (await getWallet(db, companyA))!;
    expect(after.reserved_cents).toBe(before.reserved_cents);
    expect(after.balance_cents).toBe(before.balance_cents + 200);
    const row = await db.prepare(
      "SELECT status, reserved_cents, captured_at, refunded_at, provider_msg_id FROM message_jobs WHERE id=?1"
    ).bind(id).first<{ status: string; reserved_cents: number; captured_at: string | null; refunded_at: string | null; provider_msg_id: string }>();
    expect(row).toMatchObject({ status: "failed", reserved_cents: 0, captured_at: null, provider_msg_id: "" });
    expect(row?.refunded_at).not.toBeNull();
    const ledger = await db.prepare(
      "SELECT COUNT(*) n FROM wallet_transactions WHERE idempotency_key=?1"
    ).bind("release:job-" + id).first<{ n: number }>();
    expect(ledger?.n).toBe(1);
    const auditing = await db.prepare(
      "SELECT COUNT(*) n FROM audit_log WHERE entity='message_job' AND entity_id=?1 AND action='message.not_sent_confirmed'"
    ).bind(String(id)).first<{ n: number }>();
    expect(auditing?.n).toBe(1);
  });

  it("fecha um envio gratuito sem alterar saldo, e não permite revisão precoce", async () => {
    const companyA = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'")
      .first<{ id: number }>())!.id;
    const when = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const ins = await db.prepare(
      "INSERT INTO message_jobs (company_id,kind,to_phone,template_code,status,scheduled_at,fire_deadline,price_cents,reserved_cents,last_attempt_at,idempotency_key) VALUES (?1,'test','5573999995678','tigu_lembrete','sending',?2,?2,0,0,?2,?3)"
    ).bind(companyA, when, "free-uncertain-" + Date.now()).run();
    const id = ins.meta.last_row_id as number;
    const evidence = "Consultei os eventos de envio no painel da Meta e confirmei ausência.";
    const before = (await getWallet(db, companyA))!;
    expect((await resolveUncertainNotSent(db, companyA, id, 1, evidence)).ok).toBe(false);
    const old = new Date(Date.now() - 12 * 60000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await db.prepare("UPDATE message_jobs SET last_attempt_at=?1 WHERE id=?2").bind(old, id).run();
    expect((await resolveUncertainNotSent(db, companyA, id, 1, evidence)).ok).toBe(true);
    const after = (await getWallet(db, companyA))!;
    expect(after.balance_cents).toBe(before.balance_cents);
    expect(after.reserved_cents).toBe(before.reserved_cents);
  });
});

describe("Tigu homologação: isolamento contra integrações reais", () => {
  const stagingEnv = () => ({
    ...env, DB: db, APP_ENV: "production",
    TIGU_STAGING: "1", WHATSAPP_MOCK: "1",
    PAYMENTS_MOCK: "0",
    MP_ACCESS_TOKEN: "token-que-nao-deve-ser-usado"
  }) as Env;

  it("bloqueia pagamentos externos mesmo com token por engano", async () => {
    const st = stagingEnv();
    expect(pickPaymentProvider(st, false).provider).toBeNull();
    const calls = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Não usar rede externa"));
    try {
      const created = await mpProvider(st).createPixPayment({
        amountCents: 1000, externalReference: "TESTE", description: "teste", payerEmail: "pessoa@teste.invalid"
      });
      expect(created.ok).toBe(false);
      expect((await mpProvider(st).getPaymentStatus("123")).status).toBe("error");
      expect(calls).not.toHaveBeenCalled();
    } finally {
      calls.mockRestore();
    }
  });

  it("recusa qualquer conexão Meta legada sem chamar a rede", async () => {
    const st=stagingEnv();
    const legacy={id:2,company_id:1,provider:"meta_cloud",status:"connected",phone_number_id:"123456"};
    const calls=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Não usar Graph API"));
    try {
      const res=await resolveProvider({env:st,db,conn:legacy as any,demo:false});
      expect(res.provider).toBeNull();
      expect(calls).not.toHaveBeenCalled();
    } finally {calls.mockRestore();}
  });

  it("rejeita webhooks públicos de terceiros sem afetar D1", async () => {
    const st = stagingEnv();
    for (const [path,expected] of [["/api/webhooks/whatsapp",404],["/api/webhooks/mercadopago",403]] as const) {
      const res = await app.request(path,
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ data: { id: "123" } }) },
        st
      );
      expect(res.status).toBe(expected);
    }
  });
});

describe("Página de vendas: contato gerenciado exclusivamente pelo superadmin", () => {
  it("não publica contato sem permissão e exige dados válidos", async () => {
    const initial = await api("/api/marketing/contact");
    expect(initial.status).toBe(200);
    expect(initial.body.contact.enabled).toBe(false);
    expect(initial.body.contact.whatsapp).toBe("");

    const payload = {
      enabled: true,
      whatsapp: "+55 (73) 99999-9999",
      email: "contato@tigu.test",
      title: "Quer tirar dúvidas antes de contratar o Tigu?",
      message: "Olá, gostaria de conhecer os planos do Tigu!",
    };
    expect((await api("/api/super/marketing/contact", { method: "PUT", body: JSON.stringify(payload) })).status).toBe(401);
    expect((await api("/api/super/marketing/contact", { method: "PUT", body: JSON.stringify(payload) }, cookieA)).status).toBe(403);
    expect((await api("/api/super/marketing/contact", {}, cookieA)).status).toBe(403);
    expect((await api("/api/marketing/contact")).body.contact.enabled).toBe(false);

    const createdAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const adminMail = "marketing-super-" + Date.now() + "@tigu.test";
    const superInsert = await db.prepare(
      "INSERT INTO users (platform_role,name,email,password_hash,active,created_at) VALUES ('superadmin','Admin Tigu',?1,?2,1,?3)"
    ).bind(adminMail, await hashPassword(PW), createdAt).run();
    const superId = superInsert.meta.last_row_id as number;
    const login = await api("/api/auth/login", {
      method: "POST", body: JSON.stringify({ email: adminMail, password: PW }),
    });
    expect(login.status).toBe(200);
    const cookie = login.cookie!;
    const invalid = await api("/api/super/marketing/contact", {
      method: "PUT", body: JSON.stringify({ ...payload, whatsapp: "123", email: "", title: "Teste válido" }),
    }, cookie);
    expect(invalid.status).toBe(422);
    const noContact = await api("/api/super/marketing/contact", {
      method: "PUT", body: JSON.stringify({ ...payload, whatsapp: "", email: "" }),
    }, cookie);
    expect(noContact.status).toBe(422);

    const saved = await api("/api/super/marketing/contact", {
      method: "PUT", body: JSON.stringify(payload),
    }, cookie);
    expect(saved.status).toBe(200);
    expect(saved.body.contact.whatsapp).toBe("5573999999999");
    expect(saved.body.contact.email).toBe("contato@tigu.test");

    const visible = await api("/api/marketing/contact");
    expect(visible.status).toBe(200);
    expect(visible.body.contact).toMatchObject({
      enabled: true, whatsapp: "5573999999999", email: "contato@tigu.test"
    });
    const persisted = await api("/api/super/marketing/contact", {}, cookie);
    expect(persisted.body.contact.title).toBe(payload.title);
    const log = await db.prepare(
      "SELECT COUNT(*) AS n FROM audit_log WHERE user_id=?1 AND action='platform.marketing_contact'"
    ).bind(superId).first<{ n: number }>();
    expect(log?.n).toBe(1);

    const disabled = await api("/api/super/marketing/contact", {
      method: "PUT", body: JSON.stringify({ ...saved.body.contact, enabled: false }),
    }, cookie);
    expect(disabled.status).toBe(200);
    const hidden = await api("/api/marketing/contact");
    expect(hidden.body.contact).toMatchObject({ enabled: false, whatsapp: "", email: "" });
    const adminStillHasSavedValue = await api("/api/super/marketing/contact", {}, cookie);
    expect(adminStillHasSavedValue.body.contact.whatsapp).toBe("5573999999999");
  });
});


describe("Cadastro seguro e recuperação de conta", () => {
  it("cria usuário, empresa, carteira e assinatura atomizadamente; repetição não deixa sobras", async () => {
    const stamp = String(Date.now());
    const email = "signup-atomico-" + stamp + "@teste.com";
    const body = JSON.stringify({
      company_name: "Barbearia Cadastro Atomico " + stamp,
      email, password: PW, name: "Dono Teste", phone: "5573999990011"
    });
    const results = await Promise.all([
      api("/api/auth/register", { method: "POST", body }),
      api("/api/auth/register", { method: "POST", body }),
    ]);
    expect(results.map(r => r.status).sort()).toEqual([201, 409]);
    const row = await db.prepare(
      "SELECT u.id uid,c.id cid,c.slug,m.role,s.plan_code,w.balance_cents,cs.data AS company_settings FROM users u JOIN company_memberships m ON m.user_id=u.id AND m.role='owner' JOIN companies c ON c.id=m.company_id JOIN company_settings cs ON cs.company_id=c.id JOIN subscriptions s ON s.company_id=c.id JOIN wallets w ON w.company_id=c.id WHERE u.email=?1"
    ).bind(email).first<any>();
    expect(row).not.toBeNull();
    expect(row.role).toBe("owner");
    expect(row.plan_code).toBe("free");
    expect(row.balance_cents).toBe(0);
    expect(JSON.parse(row.company_settings).shop_name).toContain("Barbearia Cadastro Atomico");
    const duplicateUser = await db.prepare("SELECT COUNT(*) n FROM users WHERE email=?1")
      .bind(email).first<{ n: number }>();
    expect(duplicateUser?.n).toBe(1);
    const secondAttempt = await api("/api/auth/register", { method: "POST", body });
    expect(secondAttempt.status).toBe(409);
  });

  it("não produz código de recuperação por HTTP em produção sem canal de entrega", async () => {
    const email = "conta-valida-teste@invalid.example";
    const request = await app.request("/api/auth/recover", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    }, { ...env, DB: db, APP_ENV: "production" } as Env);
    expect(request.status).toBe(200);
    const result: any = await request.json();
    expect(result.support_required).toBe(true);
    expect(result.demo_code).toBeUndefined();
    const resets = await db.prepare(
      "SELECT COUNT(*) n FROM password_resets p JOIN users u ON u.id=p.user_id WHERE u.email=?1"
    ).bind(email).first<{ n: number }>();
    expect(resets?.n).toBe(0);
  });

  it("contabiliza erros de código no D1 e bloqueia depois de cinco tentativas", async () => {
    const stamp = String(Date.now());
    const email = "recuperacao-" + stamp + "@teste.com";
    await db.prepare(
      "INSERT INTO users (platform_role,name,email,password_hash,active,created_at) VALUES ('user','Testador',?1,?2,1,?3)"
    ).bind(email, await hashPassword(PW), new Date().toISOString()).run();
    const recover = await api("/api/auth/recover", {
      method: "POST", body: JSON.stringify({ email })
    });
    expect(recover.status).toBe(200);
    expect(recover.body.demo_code).toHaveLength(10);
    for (let i = 0; i < 5; i++) {
      const invalid = await api("/api/auth/recover/verify", {
        method: "POST",
        body: JSON.stringify({ email, code: "INVALID000", password: "OutraSenhaForte#2026" })
      });
      expect(invalid.status).toBe(400);
    }
    const blocked = await api("/api/auth/recover/verify", {
      method: "POST",
      body: JSON.stringify({ email, code: recover.body.demo_code, password: "OutraSenhaForte#2026" })
    });
    expect(blocked.status).toBe(429);
    const row = await db.prepare(
      "SELECT attempts FROM password_resets WHERE user_id=(SELECT id FROM users WHERE email=?1) ORDER BY id DESC LIMIT 1"
    ).bind(email).first<{ attempts: number }>();
    expect(row?.attempts).toBe(5);
  });
});

describe("Roteamento HTTP dos painéis React", () => {
  it("não duplica /super nem /auth no painel administrativo", () => {
    expect(resolveApiUrl("/super/users", "/superadmin/users")).toBe("/api/super/users");
    expect(resolveApiUrl("/super/settings", "/superadmin/settings")).toBe("/api/super/settings");
    expect(resolveApiUrl("/super/companies/2/plan", "/superadmin/companies")).toBe("/api/super/companies/2/plan");
    expect(resolveApiUrl("/settings", "/superadmin/settings")).toBe("/api/super/settings");
    expect(resolveApiUrl("/marketing/contact", "/superadmin/settings")).toBe("/api/super/marketing/contact");
    expect(resolveApiUrl("/auth/login", "/login")).toBe("/api/auth/login");
    expect(resolveApiUrl("/marketing/contact", "/")).toBe("/api/marketing/contact");
    expect(resolveApiUrl("/bookings", "/c/barbearia-navalha/admin")).toBe("/api/c/barbearia-navalha/bookings");
    expect(resolveApiUrl("/api/c/alfa/barbers", "/c/alfa")).toBe("/api/c/alfa/barbers");
  });
});


describe("Troca obrigatória de senha após reset do suporte", () => {
  it("bloqueia recursos da plataforma até a troca da senha provisória", async () => {
    const at = new Date().toISOString().replace(/\\.\\d{3}Z$/, "Z");
    const email = "troca-senha-" + Date.now() + "@teste.com";
    await db.prepare(
      "INSERT INTO users (name,email,password_hash,platform_role,active,must_change_password,created_at) VALUES ('SuporteTeste',?1,?2,'superadmin',1,1,?3)"
    ).bind(email, await hashPassword(PW), at).run();
    const login = await api("/api/auth/login", {
      method: "POST", body: JSON.stringify({ email, password: PW })
    });
    expect(login.status).toBe(200);
    expect(login.body.next).toBe("/alterar-senha");
    expect(login.body.user.must_change_password).toBe(true);
    const provisionalCookie = login.cookie!;
    expect((await api("/api/super/settings", {}, provisionalCookie)).status).toBe(403);
    const before = await api("/api/auth/me", {}, provisionalCookie);
    expect(before.body.user.must_change_password).toBe(true);
    const changed = await api("/api/auth/password", {
      method: "POST",
      body: JSON.stringify({ current: PW, next: "NovaSenhaDiferente#2026" })
    }, provisionalCookie);
    expect(changed.status).toBe(200);
    const after = await api("/api/auth/me", {}, changed.cookie);
    expect(after.body.user.must_change_password).toBe(false);
    expect((await api("/api/super/settings", {}, changed.cookie)).status).toBe(200);
    expect((await api("/api/super/settings", {}, provisionalCookie)).status).toBe(401);
  });
});


describe("Planos comerciais com preço dinâmico e permissão de Superadmin", () => {
  it("consulta planos publicamente, restringe edição e publica alteração real do D1", async () => {
    const publicResult = await api("/api/marketing/plans");
    expect(publicResult.status).toBe(200);
    expect(publicResult.body.automatic_billing).toBe(false);
    expect(publicResult.body.plans.map((p: any) => p.code)).toEqual(["free","pro","scale"]);
    expect(publicResult.body.plans.every((p:any)=>
      p.max_messages_month === -1 && p.whatsapp_enabled === 1)).toBe(true);
    const pro = publicResult.body.plans.find((p: any) => p.code === "pro");
    expect(pro.price_cents_month).toBeGreaterThan(0);
    const changed = {
      name: pro.name,
      price_cents_month: pro.price_cents_month + 200,
      max_barbers: pro.max_barbers,
      max_messages_month: pro.max_messages_month,
      whatsapp_enabled: pro.whatsapp_enabled === 1,
      store_enabled: pro.store_enabled === 1,
    };
    expect((await api("/api/super/plans/pro", {method:"PUT",body:JSON.stringify(changed)})).status).toBe(401);
    expect((await api("/api/super/plans/pro", {method:"PUT",body:JSON.stringify(changed)},cookieA)).status).toBe(403);
    expect((await api("/api/marketing/plans")).body.plans.find((p: any) => p.code === "pro").price_cents_month)
      .toBe(pro.price_cents_month);

    const at = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const email = "plan-admin-" + Date.now() + "@tigu.test";
    await db.prepare("INSERT INTO users (platform_role,name,email,password_hash,active,created_at) VALUES ('superadmin','Plan admin',?1,?2,1,?3)")
      .bind(email, await hashPassword(PW), at).run();
    const login = await api("/api/auth/login", {method:"POST",body:JSON.stringify({email,password:PW})});
    expect(login.status).toBe(200);
    const cookie = login.cookie!;
    const free = publicResult.body.plans.find((p:any)=>p.code==="free");
    expect(free.price_cents_month).toBe(1999);
    expect((await api("/api/super/plans/free",{method:"PUT",body:JSON.stringify({
      name:free.name,price_cents_month:0,max_barbers:free.max_barbers,
      max_messages_month:free.max_messages_month,whatsapp_enabled:false,store_enabled:true
    })},cookie)).status).toBe(422);
    expect((await api("/api/super/plans/free",{method:"PUT",body:JSON.stringify({
      name:free.name,price_cents_month:1999,max_barbers:free.max_barbers,
      max_messages_month:free.max_messages_month,whatsapp_enabled:false,store_enabled:true
    })},cookie)).status).toBe(200);
    // Mesmo que uma tela antiga envie valores de cota ou desative o WhatsApp,
    // o cadastro do plano e o contrato efetivo permanecem ilimitados.
    const freeAfter = (await api("/api/super/plans",{},cookie)).body.plans
      .find((p:any)=>p.code==="free");
    expect(freeAfter.max_messages_month).toBe(-1);
    expect(freeAfter.whatsapp_enabled).toBe(1);
    expect((await api("/api/super/plans/pro",{method:"PUT",body:JSON.stringify({...changed,max_barbers:0})},cookie)).status).toBe(422);
    try {
      const saved = await api("/api/super/plans/pro",{method:"PUT",body:JSON.stringify(changed)},cookie);
      expect(saved.status).toBe(200);
      expect(saved.body.plan.price_cents_month).toBe(changed.price_cents_month);
      const visible = await api("/api/marketing/plans");
      expect(visible.body.plans.find((p:any)=>p.code==="pro").price_cents_month).toBe(changed.price_cents_month);
      expect((await api("/api/super/plans",{},cookie)).body.plans.length).toBe(3);
      const row = await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='platform.plan_update' AND entity_id='pro'")
        .first<{n:number}>();
      expect(row?.n).toBeGreaterThanOrEqual(1);
    } finally {
      await api("/api/super/plans/pro",{method:"PUT",body:JSON.stringify({...changed,price_cents_month:pro.price_cents_month})},cookie);
    }
  });
});


describe("Solicitações comerciais sem cobrança ou ativação", () => {
  it("exige consentimento e não aceita Start nem dados incorretos", async () => {
    const base = {
      contact_name:"Cliente Interessado",company_name:"Barbearia Comercial",
      email:"interessado@tigu.test",phone:"5573999999999",plan_code:"pro",message:"Gostaria de mais detalhes.",
      consent:true,website:""
    };
    for (const patch of [
      {consent:false},{plan_code:"free"},{phone:"1"},{email:"invalido"},{contact_name:""},
    ]) {
      const result=await api("/api/marketing/leads",{
        method:"POST",body:JSON.stringify({...base,...patch})
      });
      expect(result.status).toBe(422);
    }
    expect((await api("/api/marketing/leads",{
      method:"POST",body:JSON.stringify({...base,website:"propaganda.example"})
    })).status).toBe(201);
    const rows=await db.prepare("SELECT COUNT(*) n FROM sales_leads WHERE email=?1")
      .bind(base.email).first<{n:number}>();
    expect(rows?.n).toBe(0);
  });

  it("grava pedido com preço vigente, controla duplicidade e rate limit persistente", async () => {
    const email="lead-" + Date.now() + "@tigu.test";
    const body=JSON.stringify({
      contact_name:"Ana Pessoa",company_name:"Barbearia Ana",email,phone:"(73) 99999-9999",
      plan_code:"pro",message:"Quero conhecer o Tigu Pro",consent:true,website:""
    });
    const first=await api("/api/marketing/leads",{method:"POST",body});
    expect(first.status).toBe(201);
    expect(first.body.reference).toBeGreaterThan(0);
    const row=await db.prepare("SELECT * FROM sales_leads WHERE id=?1").bind(first.body.reference).first<any>();
    const plan=await db.prepare("SELECT price_cents_month FROM plans WHERE code='pro'").first<any>();
    expect(row.status).toBe("new");
    expect(row.plan_code).toBe("pro");
    expect(row.price_snapshot_cents).toBe(plan.price_cents_month);
    expect(row.email).toBe(email);
    expect(row.phone).toBe("73999999999");
    expect(row.consent_at).toMatch(/^\d{4}-/);
    expect((await api("/api/marketing/leads",{method:"POST",body})).status).toBe(409);
    for (let n=0;n<3;n++) expect((await api("/api/marketing/leads",{method:"POST",body})).status).toBe(409);
    expect((await api("/api/marketing/leads",{method:"POST",body})).status).toBe(429);
    const count=await db.prepare("SELECT COUNT(*) n FROM sales_leads WHERE email=?1").bind(email).first<{n:number}>();
    expect(count?.n).toBe(1);
  });

  it("somente Superadmin vê e atualiza contato, sem ativar assinatura", async () => {
    const email="pedido-" + Date.now() + "@tigu.test";
    const posted=await api("/api/marketing/leads",{method:"POST",body:JSON.stringify({
      contact_name:"Marcos Cliente",company_name:"Barbearia Novo Cliente",email,
      phone:"5573998888777",plan_code:"scale",message:"Gostaria de saber sobre planos.",consent:true,website:""
    })});
    expect(posted.status).toBe(201);
    const id=posted.body.reference;
    expect((await api("/api/super/leads")).status).toBe(401);
    expect((await api("/api/super/leads",{},cookieA)).status).toBe(403);
    expect((await api("/api/super/leads/"+id,{method:"PATCH",body:JSON.stringify({status:"contacted",internal_note:"ligar"})},cookieA)).status).toBe(403);
    const adminEmail="super-leads-" + Date.now() + "@tigu.test";
    await db.prepare("INSERT INTO users(platform_role,name,email,password_hash,active,created_at) VALUES('superadmin','Gestor Comercial',?1,?2,1,?3)")
      .bind(adminEmail,await hashPassword(PW),new Date().toISOString()).run();
    const login=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:adminEmail,password:PW})});
    expect(login.status).toBe(200);
    const cookie=login.cookie!;
    const listing=await api("/api/super/leads?status=new",{},cookie);
    expect(listing.status).toBe(200);
    expect(listing.body.leads.some((r:any)=>r.id===id&&r.email===email)).toBe(true);
    const patch=await api("/api/super/leads/"+id,{method:"PATCH",body:JSON.stringify({
      status:"negotiating",internal_note:"Enviar apresentação e proposta comercial."
    })},cookie);
    expect(patch.status).toBe(200);
    expect((await api("/api/super/leads?status=negotiating&q=Novo",{},cookie))
      .body.leads.some((r:any)=>r.id===id)).toBe(true);
    expect((await api("/api/super/leads/"+id,{method:"PATCH",body:JSON.stringify({
      status:"paid",internal_note:"não é cobrança"
    })},cookie)).status).toBe(422);
    const saved=await db.prepare("SELECT status,internal_note FROM sales_leads WHERE id=?1")
      .bind(id).first<{status:string;internal_note:string}>();
    expect(saved?.status).toBe("negotiating");
    expect(saved?.internal_note).toContain("proposta");
    const auditRow=await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='sales_lead.update' AND entity_id=?1")
      .bind(String(id)).first<{n:number}>();
    expect(auditRow?.n).toBe(1);
    const subscriptions=await db.prepare("SELECT COUNT(*) n FROM subscriptions WHERE plan_code='scale'").first<{n:number}>();
    expect(subscriptions?.n).toBe(0);
  });
});



describe("funil comercial: paginação com cursor e autorização",()=>{
  it("percorre mais de 150 contatos sem duplicar ou perder registros",async()=>{
    const unique=crypto.randomUUID();
    const statements=Array.from({length:160},(_,i)=>
      db.prepare("INSERT INTO sales_leads(contact_name,company_name,email,phone,plan_code,price_snapshot_cents,consent_at,submission_bucket) VALUES (?1,?2,?3,'5573999999999','pro',4990,?4,?5)")
        .bind("Interessado "+i,"Grupo-"+unique,`lead-${unique}-${i}@tigu.test`,new Date().toISOString(),i+1)
    );
    for(let i=0;i<statements.length;i+=40)await db.batch(statements.slice(i,i+40));
    const adminEmail="paginar-"+unique+"@tigu.test";
    await db.prepare("INSERT INTO users(platform_role,name,email,password_hash,active,created_at) VALUES('superadmin','Paginador',?1,?2,1,?3)")
      .bind(adminEmail,await hashPassword(PW),new Date().toISOString()).run();
    const login=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email:adminEmail,password:PW})});
    expect(login.status).toBe(200);
    const seen=new Set<number>();
    let cursor:number|null=null,rounds=0;
    do{
      const url="/api/super/leads?status=new&q="+encodeURIComponent("Grupo-"+unique)+(cursor?"&beforeId="+cursor:"");
      const res=await api(url,{},login.cookie!);
      expect(res.status).toBe(200);
      const data=res.body as {leads:{id:number}[];next_before_id:number|null};
      expect(data.leads.length).toBeLessThanOrEqual(50);
      for(const lead of data.leads){expect(seen.has(lead.id)).toBe(false);seen.add(lead.id);}
      cursor=data.next_before_id;rounds++;
      expect(rounds).toBeLessThan(6);
    }while(cursor!==null);
    expect(seen.size).toBe(160);
    expect(rounds).toBe(4);
    for(const value of ["abc","-1","0","1.5","999999999999999999999"]){
      expect((await api("/api/super/leads?beforeId="+value,{},login.cookie!)).status).toBe(400);
    }
    expect((await api("/api/super/leads?beforeId=123",{},cookieA)).status).toBe(403);
  });
});

describe("Cloudflare Turnstile no atendimento comercial", () => {
  const data = (email: string, turnstile_token = "") => ({
    contact_name: "Joana Teste", company_name: "Barbearia Verificacao",
    email, phone: "5573999999999", plan_code: "pro",
    message: "Desejo informações", consent: true, website: "", turnstile_token,
  });
  const request = (environment: Env, body: object) =>
    app.request("/api/marketing/leads", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }, environment);

  it("não expõe segredo nem habilita pedidos em produção sem chaves", async () => {
    const production = { ...env, DB: db, APP_ENV: "production", SESSION_SECRET: "test-only-secret",
      SALES_TURNSTILE_SECRET: undefined, SALES_TURNSTILE_SITE_KEY: undefined } as Env;
    const conf = await app.request("/api/marketing/lead-config", {}, production);
    expect(await conf.json()).toMatchObject({ required: true, enabled: false, site_key: null });
    const response = await request(production, data("sem-chave-" + Date.now() + "@tigu.test"));
    expect(response.status).toBe(503);
  });

  it("rejeita desafio ausente ou inválido sem gravar contatos", async () => {
    const production = { ...env, DB: db, APP_ENV: "production", SESSION_SECRET: "test-only-secret",
      SALES_TURNSTILE_SECRET: "private-test-secret", SALES_TURNSTILE_SITE_KEY: "public-test-site-key" } as Env;
    const conf = await app.request("/api/marketing/lead-config", {}, production);
    const dataConfig: any = await conf.json();
    expect(dataConfig).toMatchObject({ required: true, enabled: true, site_key: "public-test-site-key" });
    expect(JSON.stringify(dataConfig)).not.toContain("private-test-secret");
    const email = "desafio-invalido-" + Date.now() + "@tigu.test";
    expect((await request(production, data(email))).status).toBe(422);
    const calls = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: false }), { status: 200,
        headers: { "content-type": "application/json" } })
    );
    try {
      const rejected = await request(production, data(email, "token-invalido"));
      expect(rejected.status).toBe(422);
      expect(calls).toHaveBeenCalledTimes(1);
      const [url, options] = calls.mock.calls[0];
      expect(String(url)).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
      expect(String(options?.body)).toContain("secret=private-test-secret");
      const count = await db.prepare("SELECT COUNT(*) n FROM sales_leads WHERE email=?1")
        .bind(email).first<{ n: number }>();
      expect(count?.n).toBe(0);
    } finally { calls.mockRestore(); }
  });

  it("registra pedido somente após validação bem-sucedida do provedor", async () => {
    const production = { ...env, DB: db, APP_ENV: "production", SESSION_SECRET: "test-only-secret",
      SALES_TURNSTILE_SECRET: "private-test-secret", SALES_TURNSTILE_SITE_KEY: "public-test-site-key" } as Env;
    const email = "desafio-aprovado-" + Date.now() + "@tigu.test";
    const calls = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200,
        headers: { "content-type": "application/json" } })
    );
    try {
      const response = await request(production, data(email, "token-de-teste-validado"));
      expect(response.status).toBe(201);
      expect(calls).toHaveBeenCalledTimes(1);
      const count = await db.prepare("SELECT COUNT(*) n FROM sales_leads WHERE email=?1")
        .bind(email).first<{ n: number }>();
      expect(count?.n).toBe(1);
    } finally { calls.mockRestore(); }
  });
});


describe("Prontidão de autenticação em homologação", () => {
  it("informa presença de secrets sem expor seus valores no health", async () => {
    const secret = "secret-de-teste-ficticio-com-mais-de-trinta-e-dois-caracteres";
    const encryption = "chave-ficticia-exclusiva-da-homologacao-com-32-ou-mais-caracteres";
    const response = await app.request("/api/health", {}, {
      ...env, DB: db, APP_ENV: "production", TIGU_STAGING: "1",
      SESSION_SECRET: secret, MSG_ENC_KEY: encryption,
    } as Env);
    expect(response.status).toBe(200);
    const content = await response.json() as any;
    expect(content.staging).toBe(true);
    expect(content.security).toEqual({
      session_secret_ready: true, encryption_key_ready: true,
    });
    const raw = JSON.stringify(content);
    expect(raw).not.toContain(secret);
    expect(raw).not.toContain(encryption);
    const absent = await app.request("/api/health", {}, {
      ...env, DB: db, APP_ENV: "production", TIGU_STAGING: "1",
      SESSION_SECRET: "", MSG_ENC_KEY: "",
    } as Env);
    expect((await absent.json() as any).security).toEqual({
      session_secret_ready: false, encryption_key_ready: false,
    });
  });

  it("não cria sessão de login em produção sem secret forte", async () => {
    const response = await app.request("/api/auth/login", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "dono@a.test", password: PW }),
    }, {
      ...env, DB: db, APP_ENV: "production", SESSION_SECRET: "curto",
    } as Env);
    expect(response.status).toBe(500);
    expect(response.headers.get("set-cookie")).toBeNull();
    const result = await response.json() as any;
    expect(result.detail).toBeUndefined();
  });
});


describe("Privacidade e retenção de dados de interessados", () => {
  async function createSuper() {
    const email = "super-privacidade-" + crypto.randomUUID() + "@tigu.test";
    await db.prepare("INSERT INTO users (platform_role,name,email,password_hash,active,created_at) VALUES ('superadmin','Gestor Privacidade',?1,?2,1,?3)")
      .bind(email, await hashPassword(PW), new Date().toISOString()).run();
    const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password: PW }) });
    expect(login.status).toBe(200);
    return login.cookie!;
  }
  async function createLead(email: string) {
    const response = await api("/api/marketing/leads", {
      method: "POST",
      body: JSON.stringify({ contact_name: "Teste Privacidade", company_name: "Barbearia Retenção",
        email, phone: "5573998998899", plan_code: "pro", message: "Dúvidas",
        consent: true, website: "" }),
    });
    expect(response.status).toBe(201);
    return Number(response.body.reference);
  }

  it("publica apenas o prazo e impede edição/exclusão por usuários comuns", async () => {
    expect(await getSalesRetentionDays(db)).toBe(180);
    const privacy = await api("/api/marketing/privacy");
    expect(privacy.status).toBe(200);
    expect(privacy.body).toEqual({ retention_days: 180, purpose: "commercial_inquiry" });
    expect((await api("/api/super/leads/privacy")).status).toBe(401);
    expect((await api("/api/super/leads/privacy", {}, cookieA)).status).toBe(403);
    expect((await api("/api/super/leads/privacy", { method: "PUT", body: JSON.stringify({ days: 30 }) }, cookieA)).status).toBe(403);
    expect((await api("/api/super/leads/privacy/cleanup", { method: "POST", body: "{}" }, cookieA)).status).toBe(403);
    expect((await api("/api/super/leads/999999", { method: "DELETE", body: JSON.stringify({ reason: "privacy_request" }) }, cookieA)).status).toBe(403);
  });

  it("exclui apenas registros vencidos e mantém recentes", async () => {
    const admin = await createSuper();
    const previous = await getSalesRetentionDays(db);
    expect((await api("/api/super/leads/privacy", { method: "PUT", body: JSON.stringify({ days: 17 }) }, admin)).status).toBe(422);
    expect((await api("/api/super/leads/privacy", { method: "PUT", body: JSON.stringify({ days: 30 }) }, admin)).status).toBe(200);
    const oldId = await createLead("antigo-" + crypto.randomUUID() + "@tigu.test");
    const recentId = await createLead("recente-" + crypto.randomUUID() + "@tigu.test");
    const tooOld = new Date(Date.now() - 32 * 86_400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await db.prepare("UPDATE sales_leads SET created_at=?1 WHERE id=?2").bind(tooOld, oldId).run();

    try {
      const manual = await api("/api/super/leads/privacy/cleanup", { method: "POST", body: "{}" }, admin);
      expect(manual.status).toBe(200);
      expect(manual.body.removed).toBeGreaterThanOrEqual(1);
      expect(await db.prepare("SELECT id FROM sales_leads WHERE id=?1").bind(oldId).first()).toBeNull();
      expect(await db.prepare("SELECT id FROM sales_leads WHERE id=?1").bind(recentId).first()).not.toBeNull();
      expect((await api("/api/marketing/privacy")).body.retention_days).toBe(30);
      const auditRow = await db.prepare("SELECT COUNT(*) n FROM audit_log WHERE action='sales_leads.cleanup'")
        .first<{ n: number }>();
      expect(auditRow?.n).toBeGreaterThan(0);
    } finally {
      await api("/api/super/leads/privacy", { method: "PUT", body: JSON.stringify({ days: previous }) }, admin);
    }
  });

  it("exclusão individual exige justificativa e não conserva dados pessoais na auditoria", async () => {
    const admin = await createSuper();
    const email = "excluir-" + crypto.randomUUID() + "@tigu.test";
    const id = await createLead(email);
    expect((await api("/api/super/leads/" + id, { method: "DELETE", body: JSON.stringify({ reason: "qualquer" }) }, admin)).status).toBe(422);
    const deleted = await api("/api/super/leads/" + id, { method: "DELETE", body: JSON.stringify({ reason: "privacy_request" }) }, admin);
    expect(deleted.status).toBe(200);
    expect(await db.prepare("SELECT id FROM sales_leads WHERE id=?1").bind(id).first()).toBeNull();
    expect((await api("/api/super/leads/" + id, { method: "DELETE", body: JSON.stringify({ reason: "privacy_request" }) }, admin)).status).toBe(404);
    const auditRow = await db.prepare("SELECT meta FROM audit_log WHERE action='sales_lead.delete' AND entity_id=?1 ORDER BY id DESC LIMIT 1")
      .bind(String(id)).first<{ meta: string }>();
    expect(auditRow).not.toBeNull();
    expect(JSON.stringify(auditRow)).not.toContain(email);
    expect(auditRow?.meta).toContain("privacy_request");
  });

  it("limpa hashes de limitação somente depois da janela de 48 horas", async () => {
    const oldBucket = Math.floor(Date.now() / 3_600_000) - 60;
    const recentBucket = Math.floor(Date.now() / 3_600_000) - 4;
    await db.prepare("INSERT INTO sales_lead_rate_limits(fingerprint,hour_bucket,attempts) VALUES ('expired-fingerprint-test',?1,1)")
      .bind(oldBucket).run();
    await db.prepare("INSERT INTO sales_lead_rate_limits(fingerprint,hour_bucket,attempts) VALUES ('recent-fingerprint-test',?1,1)")
      .bind(recentBucket).run();
    expect(await purgeOldSalesRateLimits(db)).toBeGreaterThanOrEqual(1);
    expect(await db.prepare("SELECT fingerprint FROM sales_lead_rate_limits WHERE fingerprint='expired-fingerprint-test'").first()).toBeNull();
    expect(await db.prepare("SELECT fingerprint FROM sales_lead_rate_limits WHERE fingerprint='recent-fingerprint-test'").first()).not.toBeNull();
  });
});


describe("Tigu Start R$ 19,99 e teste grátis por 15 dias", () => {
  it("cadastra assinatura de teste com término exato de 15 dias", async () => {
    const mail = "trial15-" + crypto.randomUUID() + "@teste.com";
    const response = await api("/api/auth/register", { method: "POST", body: JSON.stringify({
      company_name: "Barbearia Trial 15", email: mail, password: PW,
      name: "Proprietário Teste", phone: ""
    }) });
    expect(response.status).toBe(201);
    const slug = response.body.company.slug;
    const record = await db.prepare(
      "SELECT s.status,s.started_at,s.period_end,p.price_cents_month FROM companies c JOIN subscriptions s ON s.company_id=c.id JOIN plans p ON p.code=s.plan_code WHERE c.slug=?1"
    ).bind(slug).first<{status:string;started_at:string;period_end:string;price_cents_month:number}>();
    expect(record?.status).toBe("trial");
    expect(record?.price_cents_month).toBe(1999);
    expect(record?.period_end).toBeTruthy();
    const duration = new Date(record!.period_end).getTime() - new Date(record!.started_at).getTime();
    expect(duration).toBe(15 * 24 * 60 * 60 * 1000);
    const stillActive = await api("/api/c/" + slug + "/admin/bookings", {}, response.cookie);
    expect(stillActive.status).toBe(200);
    const noCharge = await db.prepare(
      "SELECT COUNT(*) AS n FROM topup_orders WHERE company_id=(SELECT id FROM companies WHERE slug=?1)"
    ).bind(slug).first<{n:number}>();
    expect(noCharge?.n).toBe(0);
  });

  it("encerrado o teste, bloqueia novas operações sem apagar consultas ou cobrar", async () => {
    const mail = "trial-end-" + crypto.randomUUID() + "@teste.com";
    const sign = await api("/api/auth/register", { method: "POST", body: JSON.stringify({
      company_name: "Barbearia Trial End",email: mail,password: PW,name:"Proprietário Teste",phone:""
    })});
    expect(sign.status).toBe(201);
    const slug = sign.body.company.slug;
    const end = new Date(Date.now() - 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    await db.prepare("UPDATE subscriptions SET period_end=?1 WHERE company_id=(SELECT id FROM companies WHERE slug=?2)")
      .bind(end,slug).run();
    expect((await api("/api/c/" + slug + "/config")).status).toBe(200);
    expect((await api("/api/c/" + slug + "/admin/bookings",{},sign.cookie)).status).toBe(200);
    expect((await api("/api/c/" + slug + "/admin/bookings",{method:"POST",body:"{}"},sign.cookie)).status).toBe(402);
    expect((await api("/api/c/" + slug + "/bookings",{method:"POST",body:"{}"})).status).toBe(402);
    expect((await api("/api/c/" + slug + "/orders",{method:"POST",body:"{}"})).status).toBe(402);
    const unauthenticated = await api("/api/c/" + slug + "/admin/bookings",{method:"POST",body:"{}"});
    expect(unauthenticated.status).toBe(401);
    const latest = await db.prepare(
      "SELECT COUNT(*) AS n FROM topup_orders WHERE company_id=(SELECT id FROM companies WHERE slug=?1)"
    ).bind(slug).first<{n:number}>();
    expect(latest?.n).toBe(0);

    // Ativação manual pelo Superadmin: não cria cobrança automática.
    await db.prepare("UPDATE subscriptions SET status='active',period_end=strftime('%Y-%m-%dT%H:%M:%SZ','now','+1 month') WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
      .bind(slug).run();
    const allowed = await api("/api/c/" + slug + "/admin/bookings",{method:"POST",body:"{}"},sign.cookie);
    expect(allowed.status).not.toBe(402);
  });

  it("mantém status ativo liberado e bloqueia status de inadimplência", async () => {
    const { canOperateSubscription } = await import("../api/lib/trial");
    const now = new Date("2026-10-19T12:00:00.000Z");
    expect(canOperateSubscription({plan_code:"free",status:"trial",period_end:"2026-11-03T12:00:00Z"},now)).toBe(true);
    expect(canOperateSubscription({plan_code:"free",status:"trial",period_end:"2026-10-19T12:00:00Z"},now)).toBe(false);
    expect(canOperateSubscription({plan_code:"free",status:"active",period_end:"2020-01-01T00:00:00Z"},now)).toBe(false);
    expect(canOperateSubscription({plan_code:"free",status:"past_due",period_end:null},now)).toBe(false);
    expect(canOperateSubscription({plan_code:"free",status:"cancelled",period_end:null},now)).toBe(false);
  });
});


describe("Assinaturas Pix mensais via Mercado Pago", () => {
  async function newOwner(which: "a"|"b"="a") {
    const slug="pix-"+crypto.randomUUID().slice(0,8);
    const email="owner-"+crypto.randomUUID()+"@teste.com";
    const ip="198.51.100."+Math.floor(Math.random()*200+1);
    const at=new Date().toISOString();
    const user=await db.prepare("INSERT INTO users(name,email,password_hash,platform_role,active,created_at) VALUES ('Proprietário Pix',?1,?2,'user',1,?3)")
      .bind(email,await hashPassword(PW),at).run();
    const uid=Number(user.meta.last_row_id);
    const company=await db.prepare(
      "INSERT INTO companies(slug,name,status,plan_code,created_at,updated_at) VALUES (?1,'Barbearia Pix','active','free',?2,?2)"
    ).bind(slug,at).run();
    const id=Number(company.meta.last_row_id);
    await db.batch([
      db.prepare("INSERT INTO company_memberships(company_id,user_id,role,active,created_at) VALUES (?1,?2,'owner',1,?3)")
        .bind(id,uid,at),
      db.prepare("INSERT INTO company_settings(company_id,data,updated_at) VALUES (?1,'{}',?2)").bind(id,at),
      db.prepare("INSERT INTO subscriptions(company_id,plan_code,status,period_end,updated_at) VALUES (?1,'free','trial',strftime('%Y-%m-%dT%H:%M:%SZ',?2,'+15 days'),?2)")
        .bind(id,at),
      db.prepare("INSERT INTO wallets(company_id,updated_at) VALUES (?1,?2)").bind(id,at),
    ]);
    const login=await app.request("/api/auth/login",{
      method:"POST",headers:{"content-type":"application/json","cf-connecting-ip":ip},
      body:JSON.stringify({email,password:PW})
    },billingEnv());
    expect(login.status).toBe(200);
    const cookie=(login.headers.get("set-cookie")||"").split(";")[0];
    expect(cookie).toContain("aurum_session=");
    return {cookie,slug,email};
  }
  const billingEnv=():Env=>({...env,DB:db,APP_ENV:"development",TIGU_STAGING:"0",
    TIGU_PLATFORM_BILLING_MODE:"mercadopago",
    PAYMENTS_MOCK:"0",MP_ACCESS_TOKEN:"TOKEN_FICTICIO",MP_WEBHOOK_SECRET:"WH_FAKE",
    PUBLIC_URL:"https://tigu.example.test"} as Env);
  const request=(envOverride:Env,path:string,cookie:string,method="GET",body:object={})=>
    app.request(path,{method,headers:{"content-type":"application/json",cookie},
      ...(method==="GET"?{}:{body:JSON.stringify(body)})},envOverride,{waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext);
  it("no modo manual não cria Pix e registra pedido de plano sem conceder acesso",async()=>{
    const owner=await newOwner(),e={...billingEnv(),TIGU_PLATFORM_BILLING_MODE:"manual"} as Env;
    const path="/api/c/"+owner.slug+"/billing";
    const before=await db.prepare("SELECT plan_code,period_end FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
      .bind(owner.slug).first<any>();
    const network=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("não deveria chamar rede"));
    try{
      const status=await request(e,path+"/status",owner.cookie);
      expect(status.status).toBe(200);
      expect((await status.json() as any).billing_mode).toBe("manual");
      const pix=await request(e,path+"/pix",owner.cookie,"POST",{plan_code:"pro"});
      expect(pix.status).toBe(409);
      const one=await request(e,path+"/plan-request",owner.cookie,"POST",{plan_code:"pro"});
      expect(one.status).toBe(200);
      const first:any=await one.json();
      const repeat=await request(e,path+"/plan-request",owner.cookie,"POST",{plan_code:"pro"});
      expect((await repeat.json() as any).request_id).toBe(first.request_id);
      const conflict=await request(e,path+"/plan-request",owner.cookie,"POST",{plan_code:"scale"});
      expect(conflict.status).toBe(409);
      const after=await db.prepare("SELECT plan_code,period_end FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(owner.slug).first<any>();
      expect(after).toEqual(before);
      expect(network).not.toHaveBeenCalled();
    }finally{network.mockRestore();}
  });


  it("renovação externa exige Super Admin, audita e não aplica duas vezes",async()=>{
    const owner=await newOwner(),e={...billingEnv(),TIGU_PLATFORM_BILLING_MODE:"manual"} as Env;
    const co=await db.prepare("SELECT id FROM companies WHERE slug=?1").bind(owner.slug).first<{id:number}>();
    expect(co).not.toBeNull();
    const expire=new Date(Date.now()-86_400_000).toISOString().replace(/\\.\\d{3}Z$/,"Z");
    await db.prepare("UPDATE subscriptions SET period_end=?1 WHERE company_id=?2").bind(expire,co!.id).run();
    const requested=await request(e,"/api/c/"+owner.slug+"/billing/plan-request",owner.cookie,"POST",{plan_code:"pro"});
    expect(requested.status).toBe(200);
    const url="/api/super/companies/"+co!.id+"/manual-renew";
    const info={plan_code:"pro",period_months:2,amount_cents:9980,
      external_reference:"TESTE-EXTERNO-"+crypto.randomUUID(),note:"Recebimento externo confirmado pelo operador do teste."};
    expect((await request(e,url,owner.cookie,"POST",info)).status).toBe(403);
    expect((await request(e,url,"","POST",info)).status).toBe(401);
    const email="super-manual-"+crypto.randomUUID()+"@tigu.test";
    const at=new Date().toISOString().replace(/\\.\\d{3}Z$/,"Z");
    await db.prepare("INSERT INTO users(platform_role,name,email,password_hash,active,created_at) VALUES ('superadmin','Admin financeiro manual',?1,?2,1,?3)")
      .bind(email,await hashPassword(PW),at).run();
    const login=await app.request("/api/auth/login",{method:"POST",
      headers:{"content-type":"application/json","cf-connecting-ip":"198.51.100.244"},
      body:JSON.stringify({email,password:PW})},e);
    expect(login.status).toBe(200);
    const superCookie=(login.headers.get("set-cookie")||"").split(";")[0];
    const spy=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("Gateway não pode ser usado na renovação externa"));
    try {
      const first=await request(e,url,superCookie,"POST",info);
      expect(first.status).toBe(200);
      expect((await first.json() as any).ok).toBe(true);
      const sub=await db.prepare("SELECT status,plan_code,period_end FROM subscriptions WHERE company_id=?1")
        .bind(co!.id).first<{status:string;plan_code:string;period_end:string}>();
      expect(sub).toMatchObject({status:"active",plan_code:"pro"});
      expect(new Date(sub!.period_end).getTime()).toBeGreaterThan(Date.now()+50*86_400_000);
      const duplicate=await request(e,url,superCookie,"POST",info);
      expect(duplicate.status).toBe(200);
      expect((await duplicate.json() as any).already_applied).toBe(true);
      const after=await db.prepare("SELECT period_end FROM subscriptions WHERE company_id=?1")
        .bind(co!.id).first<{period_end:string}>();
      expect(after?.period_end).toBe(sub?.period_end);
      const conflict=await request(e,url,superCookie,"POST",{...info,amount_cents:10000});
      expect(conflict.status).toBe(409);
      const rows=await db.prepare("SELECT COUNT(*) n FROM manual_subscription_renewals WHERE company_id=?1")
        .bind(co!.id).first<{n:number}>();
      expect(rows?.n).toBe(1);
      const req=await db.prepare("SELECT status FROM subscription_plan_requests WHERE company_id=?1")
        .bind(co!.id).first<{status:string}>();
      expect(req?.status).toBe("approved");
      const wallet=await db.prepare("SELECT balance_cents FROM wallets WHERE company_id=?1")
        .bind(co!.id).first<{balance_cents:number}>();
      expect(wallet?.balance_cents).toBe(0);
      expect(spy).not.toHaveBeenCalled();
    }finally{spy.mockRestore();}
  });

  it("gera Pix do Start e só libera após aprovação real reconsultada, sem duplicar meses",async()=>{
    const owner=await newOwner(),e=billingEnv();
    const url="/api/c/"+owner.slug+"/billing";
    await db.prepare("UPDATE subscriptions SET period_end=?1 WHERE company_id=(SELECT id FROM companies WHERE slug=?2)")
      .bind(new Date(Date.now()-60_000).toISOString().replace(/\\.\\d{3}Z$/,"Z"),owner.slug).run();
    let code="",paymentCalls=0,statusCalls=0;
    const fetchMock=vi.spyOn(globalThis,"fetch").mockImplementation(async (input,init)=>{
      const endpoint=String(input);
      if(endpoint.endsWith("/v1/payments")&&init?.method==="POST"){
        paymentCalls++;
        const data=JSON.parse(String(init.body));
        code=data.external_reference;
        expect(data.payment_method_id).toBe("pix");
        expect(data.transaction_amount).toBe(19.99);
        return new Response(JSON.stringify({
          id:778899,point_of_interaction:{transaction_data:{qr_code:"pix-copia-cola-teste"}}
        }),{status:201,headers:{"content-type":"application/json"}});
      }
      if(endpoint.endsWith("/v1/payments/778899")){
        statusCalls++;
        return new Response(JSON.stringify({
          id:778899,status:"approved",external_reference:code,transaction_amount:19.99,
          payment_method_id:"pix",currency_id:"BRL"
        }),{status:200,headers:{"content-type":"application/json"}});
      }
      throw new Error("Rede externa inesperada: "+endpoint);
    });
    try {
      const first=await request(e,url+"/pix",owner.cookie,"POST",{plan_code:"free"});
      expect(first.status).toBe(200);
      const invoice:any=await first.json();
      expect(invoice.invoice.qr_code_text).toBe("pix-copia-cola-teste");
      expect(invoice.invoice.amount_cents).toBe(1999);
      const repeat=await request(e,url+"/pix",owner.cookie,"POST",{plan_code:"free"});
      expect((await repeat.json() as any).invoice.id).toBe(invoice.invoice.id);
      expect(paymentCalls).toBe(1);
      const before=await db.prepare("SELECT status,period_end FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(owner.slug).first<any>();
      expect(before.status).toBe("trial");
      const verify=await request(e,url+"/pix/verify",owner.cookie,"POST",{invoice_id:invoice.invoice.id});
      expect(verify.status).toBe(200);
      expect((await verify.json() as any).activated).toBe(true);
      const after=await db.prepare("SELECT status,period_end FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(owner.slug).first<any>();
      expect(after.status).toBe("active");
      expect(new Date(after.period_end).getTime()).toBeGreaterThan(Date.now()+25*86_400_000);
      const repeatVerify=await request(e,url+"/pix/verify",owner.cookie,"POST",{invoice_id:invoice.invoice.id});
      expect(repeatVerify.status).toBe(200);
      expect((await repeatVerify.json() as any).activated).toBe(false);
      const same=await db.prepare("SELECT period_end FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(owner.slug).first<any>();
      expect(same.period_end).toBe(after.period_end);
      expect(statusCalls).toBe(1);
      const wallet=await db.prepare("SELECT balance_cents FROM wallets WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(owner.slug).first<any>();
      expect(wallet.balance_cents).toBe(0);
    } finally {fetchMock.mockRestore();}
  });

  it("não ativa assinatura por Pix com valor ou método divergente",async()=>{
    const owner=await newOwner(),e=billingEnv(),url="/api/c/"+owner.slug+"/billing";
    let code="";
    const fetchMock=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      if(String(input).endsWith("/v1/payments")&&init?.method==="POST"){
        code=JSON.parse(String(init.body)).external_reference;
        return new Response(JSON.stringify({id:998877,
          point_of_interaction:{transaction_data:{qr_code:"pix-teste"}}}),{status:201});
      }
      return new Response(JSON.stringify({id:998877,status:"approved",external_reference:code,
        payment_method_id:"credit_card",currency_id:"BRL",transaction_amount:19.99}),{status:200});
    });
    try {
      const created=await request(e,url+"/pix",owner.cookie,"POST",{plan_code:"free"});
      expect(created.status).toBe(200);
      const invoice:any=(await created.json() as any).invoice;
      const response=await request(e,url+"/pix/verify",owner.cookie,"POST",{invoice_id:invoice.id});
      expect(response.status).toBe(409);
      const sub=await db.prepare("SELECT status FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(owner.slug).first<any>();
      expect(sub.status).toBe("trial");
      const dbInvoice=await db.prepare("SELECT status FROM subscription_invoices WHERE id=?1")
        .bind(invoice.id).first<any>();
      expect(dbInvoice.status).toBe("pending");
    } finally {fetchMock.mockRestore();}
  });

  it("impede QR real em homologação e não permite faturar empresa de outro dono",async()=>{
    const a=await newOwner("a"),b=await newOwner("b");
    const e=billingEnv(),st={...e,TIGU_STAGING:"1"} as Env;
    const fetchMock=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("rede proibida"));
    try {
      const blocked=await request(st,"/api/c/"+a.slug+"/billing/pix",a.cookie,"POST",{plan_code:"free"});
      expect(blocked.status).toBe(503);
      const forbidden=await request(e,"/api/c/"+b.slug+"/billing/pix",a.cookie,"POST",{plan_code:"free"});
      expect(forbidden.status).toBe(403);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {fetchMock.mockRestore();}
  });
  it("permite escolher o Pro ao terminar o teste e muda recursos só após Pix aprovado",async()=>{
    const owner=await newOwner(),e=billingEnv(),url="/api/c/"+owner.slug+"/billing";
    const expires=new Date(Date.now()-60_000).toISOString().replace(/\.\d{3}Z$/,"Z");
    await db.prepare("UPDATE subscriptions SET period_end=?1 WHERE company_id=(SELECT id FROM companies WHERE slug=?2)")
      .bind(expires,owner.slug).run();
    let code="";
    const fetchMock=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      if(String(input).endsWith("/v1/payments")&&init?.method==="POST"){
        const data=JSON.parse(String(init.body));
        expect(data.transaction_amount).toBe(49.90);
        code=data.external_reference;
        return new Response(JSON.stringify({id:345670,point_of_interaction:{transaction_data:{qr_code:"PIX-PRO"}}}),{status:201});
      }
      return new Response(JSON.stringify({
        id:345670,status:"approved",external_reference:code,payment_method_id:"pix",
        currency_id:"BRL",transaction_amount:49.90
      }),{status:200});
    });
    try{
      const created=await request(e,url+"/pix",owner.cookie,"POST",{plan_code:"pro"});
      expect(created.status).toBe(200);
      const invoice:any=(await created.json() as any).invoice;
      expect(invoice.plan_code).toBe("pro");
      expect(invoice.amount_cents).toBe(4990);
      const before=await db.prepare("SELECT plan_code,status FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(owner.slug).first<any>();
      expect(before.plan_code).toBe("free");
      const verify=await request(e,url+"/pix/verify",owner.cookie,"POST",{invoice_id:invoice.id});
      expect(verify.status).toBe(200);
      const after=await db.prepare("SELECT plan_code,status FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(owner.slug).first<any>();
      expect(after).toMatchObject({plan_code:"pro",status:"active"});
      const company=await db.prepare("SELECT plan_code FROM companies WHERE slug=?1").bind(owner.slug).first<any>();
      expect(company.plan_code).toBe("pro");
    }finally{fetchMock.mockRestore();}
  });

  it("upgrade Pro para Scale mantém dias restantes e acrescenta mês sem duplicar confirmação",async()=>{
    const owner=await newOwner(),e=billingEnv(),url="/api/c/"+owner.slug+"/billing";
    const company=await db.prepare("SELECT id FROM companies WHERE slug=?1").bind(owner.slug).first<{id:number}>();
    const oldEnd=new Date(Date.now()+10*86400000).toISOString().replace(/\.\d{3}Z$/,"Z");
    await db.prepare("UPDATE subscriptions SET plan_code='pro',status='active',period_end=?1 WHERE company_id=?2")
      .bind(oldEnd,company!.id).run();
    let code="";
    const fetchMock=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      if(String(input).endsWith("/v1/payments")&&init?.method==="POST"){
        const data=JSON.parse(String(init.body)); code=data.external_reference;
        expect(data.transaction_amount).toBe(129.90);
        return new Response(JSON.stringify({id:678912,point_of_interaction:{transaction_data:{qr_code:"PIX-SCALE"}}}),{status:201});
      }
      return new Response(JSON.stringify({id:678912,status:"approved",external_reference:code,
        payment_method_id:"pix",currency_id:"BRL",transaction_amount:129.90}),{status:200});
    });
    try{
      const downgrade=await request(e,url+"/pix",owner.cookie,"POST",{plan_code:"free"});
      expect(downgrade.status).toBe(422);
      const created=await request(e,url+"/pix",owner.cookie,"POST",{plan_code:"scale"});
      expect(created.status).toBe(200);
      const invoice:any=(await created.json() as any).invoice;
      const conflict=await request(e,url+"/pix",owner.cookie,"POST",{plan_code:"pro"});
      expect(conflict.status).toBe(409);
      const before=await db.prepare("SELECT plan_code FROM subscriptions WHERE company_id=?1")
        .bind(company!.id).first<any>();
      expect(before.plan_code).toBe("pro");
      const confirmed=await request(e,url+"/pix/verify",owner.cookie,"POST",{invoice_id:invoice.id});
      expect(confirmed.status).toBe(200);
      expect((await confirmed.json() as any).activated).toBe(true);
      const after=await db.prepare("SELECT plan_code,period_end FROM subscriptions WHERE company_id=?1")
        .bind(company!.id).first<any>();
      expect(after.plan_code).toBe("scale");
      expect(new Date(after.period_end).getTime()).toBeGreaterThan(new Date(oldEnd).getTime()+27*86400000);
      const repeated=await request(e,url+"/pix/verify",owner.cookie,"POST",{invoice_id:invoice.id});
      expect((await repeated.json() as any).activated).toBe(false);
      const again=await db.prepare("SELECT period_end FROM subscriptions WHERE company_id=?1")
        .bind(company!.id).first<any>();
      expect(again.period_end).toBe(after.period_end);
    }finally{fetchMock.mockRestore();}
  });


  it("Pix vencido só pode ser reemitido após confirmação terminal do Mercado Pago",async()=>{
    const o=await newOwner(),e=billingEnv(),url="/api/c/"+o.slug+"/billing";
    let created=0,statusCalls=0;
    const fetchMock=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      if(String(input).endsWith("/v1/payments") && init?.method==="POST"){
        created++;
        return new Response(JSON.stringify({id:490000+created,
          point_of_interaction:{transaction_data:{qr_code:"PIX-TESTE-"+created}}}),{status:201});
      }
      if(String(input).endsWith("/v1/payments/490001")){
        statusCalls++;
        return new Response(JSON.stringify({id:490001,status:"cancelled"}),{status:200});
      }
      throw new Error("Rede não prevista");
    });
    try {
      const one=await request(e,url+"/pix",o.cookie,"POST",{plan_code:"free"});
      expect(one.status).toBe(200);
      const first:any=(await one.json() as any).invoice;
      await db.prepare("UPDATE subscription_invoices SET expires_at=?1 WHERE id=?2")
        .bind(new Date(Date.now()-60_000).toISOString(),first.id).run();
      const two=await request(e,url+"/pix",o.cookie,"POST",{plan_code:"pro"});
      expect(two.status).toBe(200);
      const second:any=(await two.json() as any).invoice;
      expect(second.id).not.toBe(first.id);
      expect(second.plan_code).toBe("pro");
      expect(second.amount_cents).toBe(4990);
      expect(statusCalls).toBe(1);
      expect(created).toBe(2);
      const firstStatus=await db.prepare("SELECT status FROM subscription_invoices WHERE id=?1")
        .bind(first.id).first<{status:string}>();
      expect(firstStatus?.status).toBe("failed");
      const sub=await db.prepare("SELECT plan_code,status FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(o.slug).first<any>();
      expect(sub).toMatchObject({plan_code:"free",status:"trial"});
    }finally{fetchMock.mockRestore();}
  });

  it("Pix vencido que foi pago é confirmado, sem gerar uma segunda cobrança",async()=>{
    const o=await newOwner(),e=billingEnv(),url="/api/c/"+o.slug+"/billing";
    let code="",calls=0;
    const fetchMock=vi.spyOn(globalThis,"fetch").mockImplementation(async(input,init)=>{
      if(String(input).endsWith("/v1/payments") && init?.method==="POST"){
        calls++;code=JSON.parse(String(init.body)).external_reference;
        return new Response(JSON.stringify({id:490111,
          point_of_interaction:{transaction_data:{qr_code:"PIX-PAGO"}}}),{status:201});
      }
      return new Response(JSON.stringify({id:490111,status:"approved",transaction_amount:19.99,
        external_reference:code,currency_id:"BRL",payment_method_id:"pix"}),{status:200});
    });
    try{
      const one=await request(e,url+"/pix",o.cookie,"POST",{plan_code:"free"});
      expect(one.status).toBe(200);
      const invoice:any=(await one.json() as any).invoice;
      await db.prepare("UPDATE subscription_invoices SET expires_at=?1 WHERE id=?2")
        .bind(new Date(Date.now()-60_000).toISOString(),invoice.id).run();
      const renewed=await request(e,url+"/pix",o.cookie,"POST",{plan_code:"free"});
      expect(renewed.status).toBe(409);
      expect(calls).toBe(1);
      const row=await db.prepare("SELECT status FROM subscription_invoices WHERE id=?1")
        .bind(invoice.id).first<{status:string}>();
      expect(row?.status).toBe("paid");
      const sub=await db.prepare("SELECT status FROM subscriptions WHERE company_id=(SELECT id FROM companies WHERE slug=?1)")
        .bind(o.slug).first<{status:string}>();
      expect(sub?.status).toBe("active");
    }finally{fetchMock.mockRestore();}
  });

  it("timeout incerto na criação do Pix não permite duplicar cobranças",async()=>{
    const o=await newOwner(),e=billingEnv(),url="/api/c/"+o.slug+"/billing";
    const fetchMock=vi.spyOn(globalThis,"fetch").mockRejectedValue(new Error("network timeout"));
    try{
      const first=await request(e,url+"/pix",o.cookie,"POST",{plan_code:"free"});
      expect(first.status).toBe(503);
      const second=await request(e,url+"/pix",o.cookie,"POST",{plan_code:"free"});
      expect(second.status).toBe(409);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const inv=await db.prepare(
        "SELECT status,provider_payment_id FROM subscription_invoices WHERE company_id=(SELECT id FROM companies WHERE slug=?1)"
      ).bind(o.slug).first<any>();
      expect(inv.status).toBe("creating");
      expect(inv.provider_payment_id).toBeNull();
    }finally{fetchMock.mockRestore();}
  });

});


describe("Mensalidades Pix visíveis somente no Superadmin", () => {
  it("lista faturas sem expor códigos Pix, filtra por status e impede acesso de barbearias", async () => {
    expect((await api("/api/super/subscription-invoices")).status).toBe(401);
    expect((await api("/api/super/subscription-invoices", {}, cookieA)).status).toBe(403);

    const company = await db.prepare("SELECT id,slug,name FROM companies WHERE slug='alfa' OR slug='a' ORDER BY id ASC LIMIT 1")
      .first<{id:number;slug:string;name:string}>();
    const selected = company ?? await db.prepare("SELECT id,slug,name FROM companies ORDER BY id ASC LIMIT 1")
      .first<{id:number;slug:string;name:string}>();
    expect(selected).not.toBeNull();
    const unique = crypto.randomUUID();
    const idPending = "TIGU-SUB-EXEMPLO-PENDENTE-" + unique;
    const idPaid = "TIGU-SUB-EXEMPLO-PAGO-" + unique;
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    await db.batch([
      db.prepare(`INSERT INTO subscription_invoices
        (company_id,code,plan_code,amount_cents,status,provider_payment_id,qr_code_text,qr_code_base64,created_at,updated_at)
        VALUES (?1,?2,'free',1999,'pending',?3,'COPIA-E-COLA-SEGREDO','BASE64-PIX-SEGREDO',?4,?4)`)
        .bind(selected!.id,idPending,"fake-provider-"+unique,now),
      db.prepare(`INSERT INTO subscription_invoices
        (company_id,code,plan_code,amount_cents,status,provider_payment_id,paid_at,created_at,updated_at)
        VALUES (?1,?2,'pro',4990,'paid',?3,?4,?4,?4)`)
        .bind(selected!.id,idPaid,"fake-approved-"+unique,now),
    ]);

    const email = "super-finance-"+unique+"@tigu.test";
    await db.prepare("INSERT INTO users (platform_role,name,email,password_hash,active,created_at) VALUES ('superadmin','Admin financeiro',?1,?2,1,?3)")
      .bind(email,await hashPassword(PW),now).run();
    const login=await api("/api/auth/login",{method:"POST",body:JSON.stringify({email,password:PW})});
    expect(login.status).toBe(200);
    const cookie=login.cookie!;

    const all=await api("/api/super/subscription-invoices",{},cookie);
    expect(all.status).toBe(200);
    expect(all.body.invoices.some((i:any)=>i.code===idPaid&&i.amount_cents===4990)).toBe(true);
    expect(all.body.summary.paid_cents).toBeGreaterThanOrEqual(4990);
    expect(all.body.summary.pending_count).toBeGreaterThanOrEqual(1);
    expect(all.body.limit).toBe(100);
    expect(JSON.stringify(all.body)).not.toContain("COPIA-E-COLA-SEGREDO");
    expect(JSON.stringify(all.body)).not.toContain("BASE64-PIX-SEGREDO");

    const paid=await api("/api/super/subscription-invoices?status=paid&q="+encodeURIComponent(idPaid),{},cookie);
    expect(paid.status).toBe(200);
    expect(paid.body.invoices).toHaveLength(1);
    expect(paid.body.invoices[0].code).toBe(idPaid);
    const pending=await api("/api/super/subscription-invoices?status=pending&q="+encodeURIComponent(idPending),{},cookie);
    expect(pending.body.invoices.map((i:any)=>i.code)).toEqual([idPending]);
    expect((await api("/api/super/subscription-invoices?status=forged",{},cookie)).status).toBe(422);
  });
});

describe("WhatsApp: cada barbearia configura seu próprio tempo de lembrete", () => {
  it("altera o lembrete da Alfa, preserva a Bravo e não mexe nas confirmações", async () => {
    const a = await db.prepare("SELECT id FROM companies WHERE slug='alfa'").first<{id:number}>();
    const b = await db.prepare("SELECT id FROM companies WHERE slug='bravo'").first<{id:number}>();
    expect(a?.id).toBeGreaterThan(0);
    expect(b?.id).toBeGreaterThan(0);
    const beforeA = await loadCompanySettings(db,a!.id);
    const beforeB = await loadCompanySettings(db,b!.id);
    const req = (lead:number,enabled=true)=>({
      method:"PUT",
      body: JSON.stringify({whatsapp_reminders_enabled:enabled,reminder_lead_min:lead})
    });
    try {
      expect((await api("/api/c/alfa/admin/whatsapp/reminder-settings",req(0),cookieA)).status).toBe(422);
      expect((await api("/api/c/alfa/admin/whatsapp/reminder-settings",req(1441),cookieA)).status).toBe(422);
      const saved = await api("/api/c/alfa/admin/whatsapp/reminder-settings",req(300),cookieA);
      expect(saved.status).toBe(200);
      expect(saved.body.reminder_lead_min).toBe(300);
      const afterA = await loadCompanySettings(db,a!.id);
      const afterB = await loadCompanySettings(db,b!.id);
      expect(afterA.reminder_lead_min).toBe(300);
      expect(afterA.whatsapp_confirm_enabled).toBe(beforeA.whatsapp_confirm_enabled);
      expect(afterB.reminder_lead_min).toBe(beforeB.reminder_lead_min);
      expect(afterB.whatsapp_reminders_enabled).toBe(beforeB.whatsapp_reminders_enabled);
    } finally {
      await db.prepare("UPDATE company_settings SET data=?1 WHERE company_id=?2")
        .bind(JSON.stringify(beforeA),a!.id).run();
    }
  });
});

describe("WhatsApp: confirmação presencial por link individual", () => {
  it("exige token da reserva, confirma uma só vez e não cruza barbearias", async () => {
    const company = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'")
      .first<{id:number}>())!;
    const barber = (await db.prepare("SELECT id FROM barbers WHERE company_id=?1 LIMIT 1")
      .bind(company.id).first<{id:number}>())!;
    const service = (await db.prepare("SELECT id FROM services WHERE company_id=?1 LIMIT 1")
      .bind(company.id).first<{id:number}>())!;
    const key = crypto.randomUUID();
    const code = "WALI" + Date.now().toString(36).slice(-7).toUpperCase();
    const start = new Date(Date.now() + 4*86400000).toISOString().replace(/\.\d{3}Z$/,"Z");
    const booked = await db.prepare(`
      INSERT INTO bookings
      (company_id,code,barber_id,service_id,starts_at,ends_at,price_cents,
       status,origin,customer_name,customer_phone,whatsapp_optin,cancel_token)
      VALUES (?1,?2,?3,?4,?5,?6,4500,'confirmado','cliente','Cliente com QR',
              '5573999991234',1,?7)
    `).bind(company.id,code,barber.id,service.id,start,
      new Date(Date.parse(start)+30*60000).toISOString().replace(/\.\d{3}Z$/,"Z"),key).run();
    const bookingId = booked.meta.last_row_id;
    const req = (url:string,token:string) => api("/api/c/alfa"+url,{
      method:"POST",body:JSON.stringify({code,token})
    });
    expect((await req("/bookings/action/lookup",crypto.randomUUID())).status).toBe(404);
    expect((await req("/bookings/action/confirm",crypto.randomUUID())).status).toBe(404);
    expect((await api("/api/c/bravo/bookings/action/confirm",{
      method:"POST",body:JSON.stringify({code,token:key})
    })).status).toBe(404);
    const before = await req("/bookings/action/lookup",key);
    expect(before.status).toBe(200);
    expect(before.body.confirmed_by_customer).toBe(false);
    expect((await req("/bookings/action/confirm",key)).status).toBe(200);
    const repeat = await req("/bookings/action/confirm",key);
    expect(repeat.status).toBe(200);
    expect(repeat.body.already_confirmed).toBe(true);
    const confirmed = await req("/bookings/action/lookup",key);
    expect(confirmed.body.confirmed_by_customer).toBe(true);
    const row = await db.prepare(
      "SELECT COUNT(*) AS n FROM message_webhook_events WHERE event_uid=?1"
    ).bind("tigu:rsvp:"+bookingId+":v1").first<{n:number}>();
    expect(row!.n).toBe(1);
    // Testa a passagem do agendamento para outra versão após remarcar.
    await db.prepare("UPDATE bookings SET schedule_version=schedule_version+1 WHERE id=?1")
      .bind(bookingId).run();
    const after = await req("/bookings/action/lookup",key);
    expect(after.status).toBe(200);
    expect(after.body.confirmed_by_customer).toBe(false);
  });
});

// Regressão: a interface pública e a reserva manual devem repassar o opt-in.
// Antes, ambas omitiam whatsappOptin, e nenhum job de confirmação era criado.
describe("confirmação WhatsApp após reservar — autorização separada do LGPD", () => {
  it("não cria mensagem sem aceite; com aceite cria job para site e painel", async () => {
    const tenant = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'")
      .first<{id:number}>())!;
    await db.prepare("UPDATE whatsapp_connections SET status='connected' WHERE company_id=?1 AND provider='mock'")
      .bind(tenant.id).run();
    await db.prepare(`INSERT OR IGNORE INTO whatsapp_templates
      (company_id,code,language,category,status,body_text,active)
      VALUES (?1,'tigu_confirmacao','pt_BR','utility','approved','Olá {{1}}! Seu horário foi registrado.',1)`)
      .bind(tenant.id).run();
    const day = nextWorkday(12);
    const slots = (await api(`/api/c/alfa/availability?barberId=1&serviceId=1&day=${day}`))
      .body.slots.filter((s:any)=>s.available);
    expect(slots.length).toBeGreaterThan(7);
    const create = async (offset:number, optedIn:boolean, fromAdmin:boolean) => {
      const payload = {
        barberId:1, serviceId:1, startsAt:slots[offset].t,
        name:"Teste Confirmação " + offset, phone:"557599999" + String(1200+offset),
        whatsappOptin:optedIn, consent:true,
        idempotencyKey:crypto.randomUUID()
      };
      const endpoint=fromAdmin ? "/api/c/alfa/admin/bookings" : "/api/c/alfa/bookings";
      return api(endpoint,{method:"POST",body:JSON.stringify(payload)},fromAdmin?cookieA:undefined);
    };

    const without=await create(0,false,false);
    expect(without.status).toBe(201);
    expect(without.body.messaging.confirmation.status).toBe("skipped");
    expect(without.body.messaging.confirmation.reason).toContain("opt-in");
    const noId=without.body.booking.id;
    const noRow=await db.prepare("SELECT whatsapp_optin FROM bookings WHERE id=?1")
      .bind(noId).first<{whatsapp_optin:number}>();
    expect(noRow?.whatsapp_optin).toBe(0);
    const noJob=await db.prepare("SELECT COUNT(*) n FROM message_jobs WHERE booking_id=?1 AND kind='confirmation'")
      .bind(noId).first<{n:number}>();
    expect(noJob?.n).toBe(0);

    const publicYes=await create(3,true,false);
    expect(publicYes.status).toBe(201);
    expect(publicYes.body.booking.whatsapp_optin).toBe(1);
    expect(["scheduled","blocked_funds"]).toContain(publicYes.body.messaging.confirmation.status);
    const job=await db.prepare("SELECT COUNT(*) n FROM message_jobs WHERE booking_id=?1 AND kind='confirmation'")
      .bind(publicYes.body.booking.id).first<{n:number}>();
    expect(job?.n).toBe(1);

    const ownerYes=await create(6,true,true);
    expect(ownerYes.status).toBe(201);
    expect(ownerYes.body.messaging.confirmation).toBeDefined();
    expect(["scheduled","blocked_funds"]).toContain(ownerYes.body.messaging.confirmation.status);
    const ownerRow=await db.prepare("SELECT whatsapp_optin FROM bookings WHERE id=?1")
      .bind(ownerYes.body.id).first<{whatsapp_optin:number}>();
    expect(ownerRow?.whatsapp_optin).toBe(1);
    const ownerJob=await db.prepare("SELECT COUNT(*) n FROM message_jobs WHERE booking_id=?1 AND kind='confirmation'")
      .bind(ownerYes.body.id).first<{n:number}>();
    expect(ownerJob?.n).toBe(1);
  });
});

describe("Todos os planos TIGU: Evolution automática sem franquia mensal", () => {
  it("ignora cotas históricas de Start, Pro e Scale sem liberar mock ou Meta", async () => {
    const rows = await db.prepare(
      "SELECT code,whatsapp_enabled,max_messages_month FROM plans WHERE code IN ('free','pro','scale') ORDER BY code"
    ).all<{code:string;whatsapp_enabled:number;max_messages_month:number}>();
    expect(rows.results.length).toBe(3);
    for (const plan of rows.results) {
      // O limite numérico legado do D1 não deve impedir o envio Evolution.
      expect(planAllowsAutomaticWhatsapp(plan,"evolution")).toBe(true);
      expect(planAllowsAutomaticWhatsapp({...plan,max_messages_month:0},"evolution")).toBe(true);
      expect(planAllowsAutomaticWhatsapp({...plan,max_messages_month:1,whatsapp_enabled:0},"evolution")).toBe(true);
      expect(planAllowsAutomaticWhatsapp({...plan,whatsapp_enabled:0},"mock")).toBe(false);
      expect(planAllowsAutomaticWhatsapp({...plan,whatsapp_enabled:0},"meta_cloud")).toBe(false);
    }
    const flags=await db.prepare(`SELECT code,
      ('evolution'='evolution' OR whatsapp_enabled=1) AS allow_evolution,
      ('evolution'='evolution' OR max_messages_month<=0 OR 1000000<max_messages_month) AS unlimited_evolution,
      ('mock'='evolution' OR whatsapp_enabled=1) AS allow_mock
      FROM plans WHERE code IN ('free','pro','scale') ORDER BY code`)
      .all<{code:string;allow_evolution:number;unlimited_evolution:number;allow_mock:number}>();
    expect(flags.results.every(x=>x.allow_evolution===1 && x.unlimited_evolution===1)).toBe(true);
    expect(flags.results.find(x=>x.code==="free")?.allow_mock).toBe(0);
  });
});

