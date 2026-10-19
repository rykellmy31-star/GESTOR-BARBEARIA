/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it, vi } from "vitest";
import { confirmSubscriptionPix } from "../api/lib/subscription-billing";
import type { Env } from "../api/types";
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

  it("executa confirmação real do serviço contra D1 e impede repetição", async () => {
    const now = "2026-10-19T15:30:00Z";
    await db.prepare("INSERT INTO companies (id,slug,name,status,plan_code,created_at,updated_at) VALUES (9010,'billing-service-test','Billing Service Test','active','free',?1,?1)").bind(now).run();
    await db.prepare("INSERT INTO subscriptions (company_id,plan_code,status,period_end,updated_at) VALUES (9010,'free','active','2026-10-20T15:30:00Z',?1)").bind(now).run();
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9010,9010,'TIGU-TEST-9010','pro',4990,'pending','9010')").run();
    const fetchOriginal = globalThis.fetch;
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id:9010,status:"approved",external_reference:"TIGU-TEST-9010",
      transaction_amount:49.90,currency_id:"BRL",payment_method_id:"pix"
    }),{status:200}));
    vi.stubGlobal("fetch",fetchMock);
    try {
      const testEnv = {...env,DB:db,MP_ACCESS_TOKEN:"test-token",TIGU_STAGING:"0"} as Env;
      const first = await confirmSubscriptionPix(testEnv,"9010");
      expect(first).toMatchObject({ok:true,status:"paid",activated:true});
      const afterFirst = await db.prepare("SELECT period_end,plan_code FROM subscriptions WHERE company_id=9010").first<{period_end:string;plan_code:string}>();
      expect(afterFirst?.plan_code).toBe("pro");
      expect((await db.prepare("SELECT plan_code FROM companies WHERE id=9010").first<{plan_code:string}>())?.plan_code).toBe("pro");
      const second = await confirmSubscriptionPix(testEnv,"9010");
      expect(second).toMatchObject({ok:true,status:"paid",activated:false});
      const afterSecond = await db.prepare("SELECT period_end FROM subscriptions WHERE company_id=9010").first<{period_end:string}>();
      expect(afterSecond?.period_end).toBe(afterFirst?.period_end);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      vi.stubGlobal("fetch",fetchOriginal);
    }
  });

  it("recusa divergência de valor sem ativar assinatura", async () => {
    const now = "2026-10-19T16:00:00Z";
    await db.prepare("INSERT INTO companies (id,slug,name,status,plan_code,created_at,updated_at) VALUES (9011,'billing-mismatch-test','Billing Mismatch Test','active','free',?1,?1)").bind(now).run();
    await db.prepare("INSERT INTO subscriptions (company_id,plan_code,status,period_end,updated_at) VALUES (9011,'free','trial','2026-10-20T16:00:00Z',?1)").bind(now).run();
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9011,9011,'TIGU-TEST-9011','scale',12990,'pending','9011')").run();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id:9011,status:"approved",external_reference:"TIGU-TEST-9011",
      transaction_amount:19.99,currency_id:"BRL",payment_method_id:"pix"
    }),{status:200})));
    try {
      const result = await confirmSubscriptionPix({...env,DB:db,MP_ACCESS_TOKEN:"test-token",TIGU_STAGING:"0"} as Env,"9011");
      expect(result).toMatchObject({ok:false,status:"mismatch",activated:false});
      expect((await db.prepare("SELECT status FROM subscription_invoices WHERE id=9011").first<{status:string}>())?.status).toBe("pending");
      expect((await db.prepare("SELECT plan_code FROM subscriptions WHERE company_id=9011").first<{plan_code:string}>())?.plan_code).toBe("free");
    } finally {
      vi.stubGlobal("fetch",original);
    }
  });

  it("encaminha pagamento antigo aprovado à revisão manual sem trocar o plano", async () => {
    const now = "2026-10-19T16:30:00Z";
    await db.prepare("INSERT INTO companies (id,slug,name,status,plan_code,created_at,updated_at) VALUES (9012,'billing-late-test','Billing Late Test','active','scale',?1,?1)").bind(now).run();
    await db.prepare("INSERT INTO subscriptions (company_id,plan_code,status,period_end,updated_at) VALUES (9012,'scale','active','2026-11-20T16:30:00Z',?1)").bind(now).run();
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9012,9012,'TIGU-TEST-9012','pro',4990,'failed','9012')").run();
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9013,9012,'TIGU-TEST-9013','scale',12990,'paid','9013')").run();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch",vi.fn().mockResolvedValue(new Response(JSON.stringify({
      id:9012,status:"approved",external_reference:"TIGU-TEST-9012",
      transaction_amount:49.90,currency_id:"BRL",payment_method_id:"pix"
    }),{status:200})));
    try {
      const result = await confirmSubscriptionPix({...env,DB:db,MP_ACCESS_TOKEN:"test-token",TIGU_STAGING:"0"} as Env,"9012");
      expect(result).toMatchObject({ok:false,status:"manual_review",activated:false});
      expect((await db.prepare("SELECT plan_code FROM subscriptions WHERE company_id=9012").first<{plan_code:string}>())?.plan_code).toBe("scale");
      expect((await db.prepare("SELECT status FROM subscription_invoices WHERE id=9012").first<{status:string}>())?.status).toBe("failed");
    } finally {
      vi.stubGlobal("fetch",original);
    }
  });

  it("preserva a fatura pendente quando a API do gateway falha", async () => {
    const now = "2026-10-19T17:00:00Z";
    await db.prepare("INSERT INTO companies (id,slug,name,status,plan_code,created_at,updated_at) VALUES (9014,'billing-gateway-test','Billing Gateway Test','active','free',?1,?1)").bind(now).run();
    await db.prepare("INSERT INTO subscriptions (company_id,plan_code,status,period_end,updated_at) VALUES (9014,'free','trial','2026-10-20T17:00:00Z',?1)").bind(now).run();
    await db.prepare("INSERT INTO subscription_invoices (id,company_id,code,plan_code,amount_cents,status,provider_payment_id) VALUES (9014,9014,'TIGU-TEST-9014','pro',4990,'pending','9014')").run();
    const original = globalThis.fetch;
    vi.stubGlobal("fetch",vi.fn().mockRejectedValue(new Error("temporary network outage")));
    try {
      const result = await confirmSubscriptionPix({...env,DB:db,MP_ACCESS_TOKEN:"test-token",TIGU_STAGING:"0"} as Env,"9014");
      expect(result).toMatchObject({ok:false,status:"gateway_unavailable",activated:false});
      expect((await db.prepare("SELECT status FROM subscription_invoices WHERE id=9014").first<{status:string}>())?.status).toBe("pending");
      expect((await db.prepare("SELECT status FROM subscriptions WHERE company_id=9014").first<{status:string}>())?.status).toBe("trial");
    } finally {
      vi.stubGlobal("fetch",original);
    }
  });

});
