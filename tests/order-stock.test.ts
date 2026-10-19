/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema1 from "../migrations/0001_init.sql";
import schema6 from "../migrations/0006_request_rate_limits.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import { changeOrderStatus } from "../api/lib/orders";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"order-test-secret-at-least-32-characters"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeAll(async()=>{
  for(const schema of [schema1,schema6]) for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function fixture(stock=5){
  const slug=`stock-${crypto.randomUUID()}`;
  const companyId=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Loja')").bind(slug).run()).meta.last_row_id);
  const userId=Number((await db.prepare("INSERT INTO users(name,email,password_hash) VALUES ('Dono',?1,'unused')").bind(`${slug}@tigu.test`).run()).meta.last_row_id);
  await db.batch([
    db.prepare("INSERT INTO company_memberships(company_id,user_id,role) VALUES (?1,?2,'owner')").bind(companyId,userId),
    db.prepare("INSERT INTO subscriptions(company_id,plan_code,status,period_end) VALUES (?1,'free','active',?2)").bind(companyId,new Date(Date.now()+86400000).toISOString()),
  ]);
  const token=crypto.randomUUID();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,?3)").bind(await sha256hex(`${token}:${e.SESSION_SECRET}:${userId}`),userId,new Date(Date.now()+86400000).toISOString()).run();
  const productId=Number((await db.prepare("INSERT INTO products(company_id,slug,name,price_cents,stock) VALUES (?1,'pomada','Pomada',1999,?2)").bind(companyId,stock).run()).meta.last_row_id);
  const request=(path:string,body:object,method="POST")=>app.request(`/api/c/${slug}${path}`,{
    method,headers:{"content-type":"application/json",cookie:`aurum_session=uid.${userId}.${token}`},body:JSON.stringify(body),
  },e,ctx);
  const create=(items:{productId:number;qty:number}[])=>request("/orders",{name:"Cliente",phone:"5573999990000",items});
  const value=(sql:string)=>db.prepare(sql).bind(companyId).first("n");
  return {companyId,productId,request,create,value};
}
describe("loja: estoque e pedidos transacionais",()=>{
  it("consulta múltiplos produtos e calcula valores com preços do servidor",async()=>{
    const f=await fixture();
    const second=Number((await db.prepare("INSERT INTO products(company_id,slug,name,price_cents,stock) VALUES (?1,'shampoo','Shampoo',1500,5)").bind(f.companyId).run()).meta.last_row_id);
    const res=await f.create([{productId:f.productId,qty:2},{productId:second,qty:1}]);
    expect(res.status).toBe(201);
    expect((await res.json() as {total:number}).total).toBe(54.98);
    expect(await db.prepare("SELECT stock FROM products WHERE id=?1").bind(f.productId).first("stock")).toBe(3);
    expect(await db.prepare("SELECT stock FROM products WHERE id=?1").bind(second).first("stock")).toBe(4);
  });
  it("itens repetidos não ultrapassam o estoque nem deixam pedido parcial",async()=>{
    const f=await fixture(3);
    expect((await f.create([{productId:f.productId,qty:2},{productId:f.productId,qty:2}])).status).toBe(409);
    expect(await f.value("SELECT count(*) n FROM orders WHERE company_id=?1")).toBe(0);
    expect(await f.value("SELECT count(*) n FROM stock_movements WHERE company_id=?1")).toBe(0);
    expect(await db.prepare("SELECT stock FROM products WHERE id=?1").bind(f.productId).first("stock")).toBe(3);
  });
  it("duas compras concorrentes da última unidade produzem só um pedido",async()=>{
    const f=await fixture(1),items=[{productId:f.productId,qty:1}];
    const responses=await Promise.all([f.create(items),f.create(items)]);
    expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
    expect(await f.value("SELECT count(*) n FROM orders WHERE company_id=?1")).toBe(1);
    expect(await f.value("SELECT sum(delta) n FROM stock_movements WHERE company_id=?1")).toBe(-1);
  });
  it("POST e PATCH concorrentes de cancelamento repõem vários produtos uma única vez",async()=>{
    const f=await fixture(5);
    const second=Number((await db.prepare("INSERT INTO products(company_id,slug,name,price_cents,stock) VALUES (?1,'shampoo','Shampoo',1500,5)").bind(f.companyId).run()).meta.last_row_id);
    expect((await f.create([{productId:f.productId,qty:2},{productId:second,qty:3}])).status).toBe(201);
    const orderId=await db.prepare("SELECT id FROM orders WHERE company_id=?1").bind(f.companyId).first<number>("id");
    const cancel=(method:string)=>f.request(`/admin/orders/${orderId}/status`,{status:"cancelado"},method);
    expect((await Promise.all([cancel("POST"),cancel("PATCH")])).every(r=>r.status===200)).toBe(true);
    expect((await cancel("PATCH")).status).toBe(200);
    expect(await db.prepare("SELECT stock FROM products WHERE id=?1").bind(f.productId).first("stock")).toBe(5);
    expect(await db.prepare("SELECT stock FROM products WHERE id=?1").bind(second).first("stock")).toBe(5);
    expect(await f.value("SELECT count(*) n FROM stock_movements WHERE company_id=?1 AND delta>0")).toBe(2);
    expect((await f.request(`/admin/orders/${orderId}/status`,{status:"pago"},"PATCH")).status).toBe(409);
  });
  it("ajuste manual sem saldo não cria movimento fictício",async()=>{
    const f=await fixture(1);
    expect((await f.request(`/admin/products/${f.productId}/stock`,{delta:-2,reason:"Teste de saldo"})).status).toBe(409);
    expect(await f.value("SELECT count(*) n FROM stock_movements WHERE company_id=?1")).toBe(0);
    expect(await db.prepare("SELECT stock FROM products WHERE id=?1").bind(f.productId).first("stock")).toBe(1);
  });
  it("falha na reposição reverte status e notificação na mesma transação",async()=>{
    const f=await fixture();
    expect((await f.create([{productId:f.productId,qty:1}])).status).toBe(201);
    const orderId=await db.prepare("SELECT id FROM orders WHERE company_id=?1").bind(f.companyId).first<number>("id");
    const trigger=`stock_fail_${f.companyId}`;
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON stock_movements
      WHEN NEW.company_id=${f.companyId} AND NEW.delta>0 BEGIN SELECT RAISE(ABORT,'simulated ledger failure'); END`).run();
    try {
      await expect(changeOrderStatus(db,f.companyId,orderId!,"cancelado")).rejects.toThrow();
      expect(await db.prepare("SELECT status FROM orders WHERE id=?1").bind(orderId).first("status")).toBe("novo");
      expect(await f.value("SELECT count(*) n FROM notifications WHERE company_id=?1")).toBe(1);
      expect(await db.prepare("SELECT stock FROM products WHERE id=?1").bind(f.productId).first("stock")).toBe(4);
    } finally { await db.prepare(`DROP TRIGGER ${trigger}`).run(); }
  });
});
