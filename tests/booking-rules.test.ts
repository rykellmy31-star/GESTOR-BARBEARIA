// ============================================================================
// Regras críticas da Tigu (runtime real do Workers via vitest-pool-workers):
// fuso/grade, catálogo por empresa, disponibilidade, trava de conflito,
// idempotência, cancelamento público com liberação do slot, bloqueio pela
// barbearia e ISOLAMENTO multi-tenant (RBAC no servidor).
// ============================================================================
/// <reference types="@cloudflare/vitest-pool-workers" />
import { beforeAll, describe, expect, it } from "vitest";
import { SELF, env } from "cloudflare:test";
import type { Env } from "../api/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {}
}
import schema0001 from "../migrations/0001_init.sql";
import { hashPassword } from "../api/lib/crypto";
import { localToUtc, utcToLocal, tzOffsetMinutes } from "../api/lib/time";
import { slotKeysFor } from "../api/lib/availability";
import { manualAdjustment, creditTopup, reserveForJob, releaseJobReservation, captureJobCharge, refundJobCharge, getWallet } from "../api/lib/wallet";

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
