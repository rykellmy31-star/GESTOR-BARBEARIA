/// <reference types="@cloudflare/vitest-pool-workers" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema1 from "../migrations/0001_init.sql";
import schema2 from "../migrations/0002_whatsapp_identity.sql";
import schema3 from "../migrations/0003_sales_leads.sql";
import schema4 from "../migrations/0004_start_trial.sql";
import schema5 from "../migrations/0005_subscription_pix.sql";

const db = env.DB as D1Database;
async function migrate(sql: string) {
  const statements = sql.replace(/--[^\n]*/g, "").split(";").map(x => x.trim()).filter(Boolean);
  for (const statement of statements) await db.prepare(statement).run();
}

beforeAll(async () => {
  for (const sql of [schema1,schema2,schema3,schema4,schema5]) await migrate(sql);
  const now = "2026-10-19T13:00:00Z";
  await db.prepare("INSERT INTO companies (id,slug,name,status,plan_code,created_at,updated_at) VALUES (9001,'billing-regression','Billing Regression','active','free',?1,?1)").bind(now).run();
  await db.prepare("INSERT INTO subscriptions (company_id,plan_code,status,period_end,updated_at) VALUES (9001,'free','active','2026-10-20T13:00:00Z',?1)").bind(now).run();
  await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9001,9001,'TIGU-TEST-9001','pro',4990,'pending','9001')").run();
});

describe("regressão D1: confirmação Pix idempotente", () => {
  it("não estende a assinatura ao repetir confirmação no mesmo segundo", async () => {
    const at = "2026-10-19T13:01:00Z";
    async function confirm() {
      return db.batch([
        db.prepare("UPDATE subscription_invoices SET status='paid',paid_at=?1,updated_at=?1 WHERE id=9001 AND status IN ('pending','expired')").bind(at),
        db.prepare(`UPDATE subscriptions SET status='active',plan_code='pro',
          period_end=strftime('%Y-%m-%dT%H:%M:%SZ',
            CASE WHEN period_end>?1 THEN period_end ELSE ?1 END,'+1 month'),
          updated_at=?1 WHERE company_id=9001 AND changes()=1
          AND EXISTS (SELECT 1 FROM subscription_invoices WHERE id=9001 AND status='paid' AND paid_at=?1)`).bind(at),
        db.prepare("UPDATE companies SET plan_code='pro',updated_at=?1 WHERE id=9001 AND changes()=1").bind(at),
      ]);
    }
    const first = await confirm();
    expect(first.map(x => x.meta.changes)).toEqual([1,1,1]);
    const afterFirst = await db.prepare("SELECT period_end FROM subscriptions WHERE company_id=9001").first<{period_end:string}>();
    const second = await confirm();
    expect(second.map(x => x.meta.changes)).toEqual([0,0,0]);
    const afterSecond = await db.prepare("SELECT period_end FROM subscriptions WHERE company_id=9001").first<{period_end:string}>();
    expect(afterSecond?.period_end).toBe(afterFirst?.period_end);
  });
  it("não aplica duas renovações sob confirmações concorrentes", async () => {
    const at = "2026-10-19T14:00:00Z";
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9002,9001,'TIGU-TEST-9002','pro',4990,'pending','9002')").run();
    async function confirm() {
      return db.batch([
        db.prepare("UPDATE subscription_invoices SET status='paid',paid_at=?1 WHERE id=9002 AND status IN ('pending','expired')").bind(at),
        db.prepare(`UPDATE subscriptions SET period_end=strftime('%Y-%m-%dT%H:%M:%SZ',period_end,'+1 month')
          WHERE company_id=9001 AND changes()=1 AND EXISTS
          (SELECT 1 FROM subscription_invoices WHERE id=9002 AND status='paid' AND paid_at=?1)`).bind(at),
      ]);
    }
    const initial = await db.prepare("SELECT period_end FROM subscriptions WHERE company_id=9001").first<{period_end:string}>();
    const results = await Promise.all([confirm(),confirm()]);
    expect(results.map(r=>r[0].meta.changes).sort()).toEqual([0,1]);
    expect(results.map(r=>r[1].meta.changes).sort()).toEqual([0,1]);
    const end = await db.prepare("SELECT period_end FROM subscriptions WHERE company_id=9001").first<{period_end:string}>();
    expect(end?.period_end).toBe(await db.prepare("SELECT strftime('%Y-%m-%dT%H:%M:%SZ',?1,'+1 month') AS date").bind(initial!.period_end).first<{date:string}>().then(r=>r?.date));
  });

  it("não ativa assinatura quando a fatura ainda não está paga", async () => {
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9003,9001,'TIGU-TEST-9003','scale',12990,'pending','9003')").run();
    const at = "2026-10-19T14:02:00Z";
    const before = await db.prepare("SELECT period_end,plan_code FROM subscriptions WHERE company_id=9001").first<{period_end:string;plan_code:string}>();
    const result = await db.prepare(`UPDATE subscriptions SET plan_code='scale',period_end=strftime('%Y-%m-%dT%H:%M:%SZ',period_end,'+1 month')
      WHERE company_id=9001 AND changes()=1 AND EXISTS
      (SELECT 1 FROM subscription_invoices WHERE id=9003 AND status='paid' AND paid_at=?1)`).bind(at).run();
    expect(result.meta.changes).toBe(0);
    const after = await db.prepare("SELECT period_end,plan_code FROM subscriptions WHERE company_id=9001").first<{period_end:string;plan_code:string}>();
    expect(after).toEqual(before);
  });

  it("permite conciliar fatura marcada failed quando o gateway aprova tardiamente", async () => {
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9004,9001,'TIGU-TEST-9004','pro',4990,'failed','9004')").run();
    const result = await db.prepare("UPDATE subscription_invoices SET status='paid',paid_at=?1 WHERE id=9004 AND status IN ('pending','expired','failed')").bind("2026-10-19T14:10:00Z").run();
    expect(result.meta.changes).toBe(1);
    const repeated = await db.prepare("UPDATE subscription_invoices SET status='paid' WHERE id=9004 AND status IN ('pending','expired','failed')").run();
    expect(repeated.meta.changes).toBe(0);
  });

  it("não deixa Pix antigo sobrescrever plano de fatura mais recente paga", async () => {
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9005,9001,'TIGU-TEST-9005','free',1999,'failed','9005')").run();
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9006,9001,'TIGU-TEST-9006','scale',12990,'paid','9006')").run();
    const result = await db.prepare(`UPDATE subscription_invoices SET status='paid',paid_at='2026-10-19T15:00:00Z'
      WHERE id=9005 AND status IN ('pending','expired','failed')
      AND NOT EXISTS (SELECT 1 FROM subscription_invoices newer
        WHERE newer.company_id=subscription_invoices.company_id
        AND newer.id>subscription_invoices.id AND newer.status='paid')`).run();
    expect(result.meta.changes).toBe(0);
    expect((await db.prepare("SELECT status FROM subscription_invoices WHERE id=9005").first<{status:string}>())?.status).toBe("failed");
  });

});
