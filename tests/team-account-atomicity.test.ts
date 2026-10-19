/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { createTeamAccount } from "../api/lib/team-accounts";
const db = env.DB as D1Database;
beforeAll(async () => {
  for (const sql of schema.replace(/--[^\n]*/g, "").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function fixture() {
  const companyId = Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Equipe atômica')").bind(crypto.randomUUID()).run()).meta.last_row_id);
  const barberId = Number((await db.prepare("INSERT INTO barbers(company_id,slug,name) VALUES (?1,'staff','Profissional')").bind(companyId).run()).meta.last_row_id);
  const email = `atomic-${crypto.randomUUID()}@tigu.test`;
  const input = {companyId,barberId,email,name:"Equipe",passwordHash:crypto.randomUUID(),role:"barber" as const,welcomeTitle:"Boas-vindas"};
  const account = () => db.prepare("SELECT id FROM users WHERE email=?1").bind(email).first<number>("id");
  return {companyId,barberId,email,input,account};
}
describe("cadastro de equipe transacional", () => {
  it("cria conta, acesso e aviso sem substituir vínculo existente", async () => {
    const f = await fixture(), result = await createTeamAccount(db,f.input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw Error(result.message);
    expect(await f.account()).toBe(result.userId);
    expect(await db.prepare("SELECT role,barber_id,active FROM company_memberships WHERE user_id=?1").bind(result.userId).first()).toEqual({role:"barber",barber_id:f.barberId,active:1});
    expect(await db.prepare("SELECT count(*) n FROM notifications WHERE user_id=?1").bind(result.userId).first("n")).toBe(1);
  });
  it("falha na notificação reverte também a conta e permite repetir o cadastro", async () => {
    const f = await fixture(), trigger = `notify_fail_${f.companyId}`;
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON notifications WHEN NEW.company_id=${f.companyId} BEGIN SELECT RAISE(ABORT,'test team notification failure'); END`).run();
    try { await expect(createTeamAccount(db,f.input)).rejects.toThrow(/test team notification failure/); }
    finally { await db.prepare(`DROP TRIGGER ${trigger}`).run(); }
    expect(await f.account()).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM company_memberships WHERE company_id=?1").bind(f.companyId).first("n")).toBe(0);
    expect((await createTeamAccount(db,f.input)).ok).toBe(true);
  });
  it("falha no vínculo não ocupa e-mail com conta órfã", async () => {
    const f = await fixture(), trigger = `member_fail_${f.companyId}`;
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON company_memberships WHEN NEW.company_id=${f.companyId} BEGIN SELECT RAISE(ABORT,'test team membership failure'); END`).run();
    try { await expect(createTeamAccount(db,f.input)).rejects.toThrow(/test team membership failure/); }
    finally { await db.prepare(`DROP TRIGGER ${trigger}`).run(); }
    expect(await f.account()).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM notifications WHERE company_id=?1").bind(f.companyId).first("n")).toBe(0);
  });
  it("dois cadastros do mesmo e-mail produzem uma conta e um acesso", async () => {
    const f = await fixture();
    const results = await Promise.all([createTeamAccount(db,f.input),createTeamAccount(db,{...f.input,passwordHash:crypto.randomUUID()})]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(results.filter(r=>!r.ok)).toHaveLength(1);
    expect(await db.prepare("SELECT count(*) n FROM users WHERE email=?1").bind(f.email).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM company_memberships WHERE company_id=?1").bind(f.companyId).first("n")).toBe(1);
    expect(await db.prepare("SELECT count(*) n FROM notifications WHERE company_id=?1").bind(f.companyId).first("n")).toBe(1);
  });
  it("profissional desativado entre leitura e commit não ganha conta ou aviso", async () => {
    const f = await fixture();
    const racing = { prepare:(sql:string)=>db.prepare(sql), batch:async(statements:D1PreparedStatement[])=>{
      await db.prepare("UPDATE barbers SET active=0 WHERE id=?1").bind(f.barberId).run();
      return db.batch(statements);
    }} as D1Database;
    expect((await createTeamAccount(racing,f.input)).ok).toBe(false);
    expect(await f.account()).toBeNull();
    expect(await db.prepare("SELECT count(*) n FROM notifications WHERE company_id=?1").bind(f.companyId).first("n")).toBe(0);
  });
  it("não vincula profissional estrangeiro nem cria conta em empresa suspensa", async () => {
    const f = await fixture(), other = await fixture();
    expect((await createTeamAccount(db,{...f.input,barberId:other.barberId})).ok).toBe(false);
    await db.prepare("UPDATE companies SET status='suspended' WHERE id=?1").bind(f.companyId).run();
    expect((await createTeamAccount(db,f.input)).ok).toBe(false);
    expect(await f.account()).toBeNull();
  });
  it("cadastro de gerente ignora vínculo de profissional e mantém troca obrigatória", async () => {
    const f = await fixture();
    const result = await createTeamAccount(db,{...f.input,role:"manager",barberId:999999,welcomeTitle:undefined});
    expect(result.ok).toBe(true);
    const id = await f.account();
    expect(await db.prepare("SELECT role,barber_id FROM company_memberships WHERE user_id=?1").bind(id).first()).toEqual({role:"manager",barber_id:null});
    expect(await db.prepare("SELECT must_change_password FROM users WHERE id=?1").bind(id).first("must_change_password")).toBe(1);
  });
});
