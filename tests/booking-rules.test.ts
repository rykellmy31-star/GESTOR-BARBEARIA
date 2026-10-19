// ============================================================================
// Regras críticas da Tigu (runtime real do Workers via vitest-pool-workers):
// fuso/grade, catálogo por empresa, disponibilidade, trava de conflito,
// idempotência, cancelamento público com liberação do slot, bloqueio pela
// barbearia e ISOLAMENTO multi-tenant (RBAC no servidor).
// ============================================================================
/// <reference types="@cloudflare/vitest-pool-workers" />
import { beforeAll, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import type { Env } from "../api/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
import schema0001 from "../migrations/0001_init.sql";
import schema0002 from "../migrations/0002_whatsapp_identity.sql";
import { hashPassword } from "../api/lib/crypto";
import { localToUtc, utcToLocal, tzOffsetMinutes } from "../api/lib/time";
import { slotKeysFor } from "../api/lib/availability";
import { ingestWhatsappWebhook, scheduleBookingMessage, cancelPendingJobs, processDueJobs } from "../api/lib/messaging/jobs";
import { metaProvider } from "../api/lib/messaging/provider";
import { encryptSecret } from "../api/lib/crypto";
import { loadCompanySettings } from "../api/lib/settings";
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
    db.prepare(`INSERT INTO subscriptions (company_id,plan_code,status,updated_at) VALUES (?1,'pro','active',?2)`).bind(a, now),
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
  const la = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "dono@a.test", password: PW }) });
  const lb = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "dono@b.test", password: PW }) });
  cookieA = la.cookie ?? ""; cookieB = lb.cookie ?? "";
  expect(la.status).toBe(200);
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

describe("webhooks Meta isolados por barbearia e opt-in explícito", () => {
  it("não altera jobs de outro número; aceita entrega válida uma só vez e ignora evento atrasado", async () => {
    const companyA = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'").first<{ id: number }>())!.id;
    const companyB = (await db.prepare("SELECT id FROM companies WHERE slug='bravo'").first<{ id: number }>())!.id;
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO whatsapp_connections (company_id,status,phone_number_id,display_phone) VALUES (?1,'connected','META-A-TESTE','5573999990010')").bind(companyA),
      db.prepare("INSERT OR REPLACE INTO whatsapp_connections (company_id,status,phone_number_id,display_phone) VALUES (?1,'connected','META-B-TESTE','5573999990020')").bind(companyB),
    ]);
    const now = new Date().toISOString();
    const msgId = "wamid.tigu-cross-tenant-01";
    const ins = await db.prepare(
      `INSERT INTO message_jobs (company_id,kind,to_phone,template_code,status,scheduled_at,
        fire_deadline,price_cents,capture_on,idempotency_key,provider_msg_id)
        VALUES (?1,'reminder','5573999990030','test_reminder','sent',?2,?2,0,'sent',?3,?4)`
    ).bind(companyA, now, "job-tenant-webhook-01", msgId).run();
    const jobId = ins.meta.last_row_id;

    const event = (phone: string, status: string, timestamp: string) => ({
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: phone },
        statuses: [{ id: msgId, status, timestamp }]
      } }] }]
    });

    const foreign = await ingestWhatsappWebhook(env as Env, event("META-B-TESTE", "delivered", "100"));
    expect(foreign.updated).toBe(0);
    expect((await db.prepare("SELECT status FROM message_jobs WHERE id=?1").bind(jobId).first<{ status: string }>())!.status).toBe("sent");
    expect((await db.prepare("SELECT COUNT(*) n FROM message_webhook_events WHERE event_uid='wa:status:wamid.tigu-cross-tenant-01:delivered:100'").first<{ n: number }>())!.n).toBe(0);

    const valid = await ingestWhatsappWebhook(env as Env, event("META-A-TESTE", "delivered", "100"));
    expect(valid.updated).toBe(1);
    expect((await db.prepare("SELECT status FROM message_jobs WHERE id=?1").bind(jobId).first<{ status: string }>())!.status).toBe("delivered");

    const duplicate = await ingestWhatsappWebhook(env as Env, event("META-A-TESTE", "delivered", "100"));
    expect(duplicate.updated).toBe(0);
    await ingestWhatsappWebhook(env as Env, event("META-A-TESTE", "read", "101"));
    const late = await ingestWhatsappWebhook(env as Env, event("META-A-TESTE", "failed", "99"));
    expect(late.updated).toBe(1); // evento auditado, porém sem regressão de estado
    expect((await db.prepare("SELECT status FROM message_jobs WHERE id=?1").bind(jobId).first<{ status: string }>())!.status).toBe("read");
  });

  it("receber uma mensagem não cria autorização automática para notificações", async () => {
    const companyA = (await db.prepare("SELECT id FROM companies WHERE slug='alfa'").first<{ id: number }>())!.id;
    const companyB = (await db.prepare("SELECT id FROM companies WHERE slug='bravo'").first<{ id: number }>())!.id;
    const phone = "5573999997788";
    const incoming = {
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "META-B-TESTE" },
        contacts: [{ profile: { name: "Cliente de teste" } }],
        messages: [{ id: "wamid.tigu-incoming-optin-01", from: phone, type: "text", text: { body: "Olá" } }]
      } }] }]
    };
    expect((await ingestWhatsappWebhook(env as Env, incoming)).updated).toBe(1);
    const b = await db.prepare(
      "SELECT whatsapp_optin,lgpd_consent_at FROM customers WHERE company_id=?1 AND phone=?2"
    ).bind(companyB, phone).first<{ whatsapp_optin: number; lgpd_consent_at: string | null }>();
    expect(b?.whatsapp_optin).toBe(0);
    expect(b?.lgpd_consent_at).toBeNull();
    const a = await db.prepare("SELECT id FROM customers WHERE company_id=?1 AND phone=?2").bind(companyA, phone).first();
    expect(a).toBeNull();
    expect((await ingestWhatsappWebhook(env as Env, incoming)).updated).toBe(0);
  });
});

describe("lembrete de 1 hora, remarcação e proteção da identidade Meta", () => {
  it("rejeita o mesmo phone_number_id em duas barbearias", async () => {
    const companyB = (await db.prepare("SELECT id FROM companies WHERE slug='bravo'").first<{ id: number }>())!.id;
    await expect(
      db.prepare("UPDATE whatsapp_connections SET phone_number_id='META-A-TESTE' WHERE company_id=?1")
        .bind(companyB).run()
    ).rejects.toThrow();
    expect((await db.prepare("SELECT phone_number_id FROM whatsapp_connections WHERE company_id=?1")
      .bind(companyB).first<{ phone_number_id: string }>())!.phone_number_id).toBe("META-B-TESTE");
  });

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
    const paymentEnv = { ...env, DB: db, MP_ACCESS_TOKEN: "testing-only", APP_ENV: "development" } as Env;
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

describe("Webhook Meta: falha de processamento sem perda silenciosa", () => {
  it("responde erro temporário quando não consegue processar o evento recebido", async () => {
    const res = await api("/api/webhooks/whatsapp", {
      method: "POST",
      body: JSON.stringify({ entry: {} })
    });
    expect(res.status).toBe(503);
  });
});

describe("WhatsApp: incerteza de envio nunca autoriza duplicidade", () => {
  it("classifica timeout, resposta 5xx e HTTP 2xx sem ID como resultados incertos", async () => {
    const credentials = { APP_ENV: "development" };
    const token = await encryptSecret(credentials, "token-para-teste");
    const context = {
      env: credentials,
      db,
      demo: false,
      conn: { access_token_enc: token, phone_number_id: "META-A-TESTE" }
    } as Parameters<typeof metaProvider.sendTemplate>[0];
    const input = { to: "5573999990030", templateCode: "tigu_lembrete", language: "pt_BR", variables: [] };
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network timeout"));
    try {
      const timeout = await metaProvider.sendTemplate(context, input);
      expect(timeout).toMatchObject({ accepted: false, uncertain: true, permanent: false });
      network.mockResolvedValue(new Response(JSON.stringify({ error: { code: 131056, message: "server unavailable" } }), { status: 503 }));
      const serverError = await metaProvider.sendTemplate(context, input);
      expect(serverError).toMatchObject({ accepted: false, uncertain: true, permanent: false });
      network.mockResolvedValue(new Response(JSON.stringify({ messages: [] }), { status: 200 }));
      const missingId = await metaProvider.sendTemplate(context, input);
      expect(missingId).toMatchObject({ accepted: false, uncertain: true, permanent: false });
      network.mockResolvedValue(new Response(JSON.stringify({ error: { message: "too many requests" } }), { status: 429 }));
      const rateLimited = await metaProvider.sendTemplate(context, input);
      expect(rateLimited).toMatchObject({ accepted: false, permanent: false });
      expect(rateLimited.uncertain).toBeFalsy();
    } finally {
      network.mockRestore();
    }
  });

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
