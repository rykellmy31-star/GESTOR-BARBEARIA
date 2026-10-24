/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { updateTeamAccess, type TeamMemberSnapshot } from "../api/lib/team-access";
const db = env.DB as D1Database;
beforeAll(async () => {
  for (const sql of schema.replace(/--[^\n]*/g, "").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function fixture() {
  const companyId = Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Acessos')").bind(crypto.randomUUID()).run()).meta.last_row_id);
  const userId = Number((await db.prepare("INSERT INTO users(name,email,password_hash) VALUES ('Equipe',?1,'original')").bind(`${crypto.randomUUID()}@tigu.test`).run()).meta.last_row_id);
  const barberId = Number((await db.prepare("INSERT INTO barbers(company_id,slug,name) VALUES (?1,'staff','Profissional')").bind(companyId).run()).meta.last_row_id);
  const membershipId = Number((await db.prepare("INSERT INTO company_memberships(company_id,user_id,role,barber_id) VALUES (?1,?2,'barber',?3)").bind(companyId,userId,barberId).run()).meta.last_row_id);
  await db.batch([
    db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,'2099-01-01T00:00:00Z')").bind(crypto.randomUUID(),userId),
    db.prepare("INSERT INTO password_resets(user_id,code_hash,expires_at) VALUES (?1,'code','2099-01-01T00:00:00Z')").bind(userId),
  ]);
  const snapshot = () => db.prepare("SELECT m.*,u.password_hash FROM company_memberships m JOIN users u ON u.id=m.user_id WHERE m.id=?1").bind(membershipId).first<TeamMemberSnapshot>();
  const before = (await snapshot())!;
  const next = {role:"barber" as const,barberId,active:1,validateBarber:false,validateUser:false,passwordHash:crypto.randomUUID()};
  const sessions = () => db.prepare("SELECT count(*) n FROM sessions WHERE user_id=?1").bind(userId).first("n");
  const codes = () => db.prepare("SELECT count(*) n FROM password_resets WHERE user_id=?1 AND used_at IS NULL").bind(userId).first("n");
  return {companyId,userId,barberId,membershipId,before,next,snapshot,sessions,codes};
}
function beforeBatch(action:()=>Promise<unknown>) {
  return {prepare:(sql:string)=>db.prepare(sql),batch:async(statements:D1PreparedStatement[])=>{await action();return db.batch(statements);}} as D1Database;
}
describe("equipe: permissões conferidas na transação", () => {
  it("vínculo externo criado durante reset impede troca e revogação de sessões/códigos", async () => {
    const f = await fixture(), other = await fixture();
    const racing = beforeBatch(()=>db.prepare("INSERT INTO company_memberships(company_id,user_id,role) VALUES (?1,?2,'manager')").bind(other.companyId,f.userId).run());
    expect(await updateTeamAccess(racing,f.companyId,f.before,f.next)).toBe(false);
    expect((await f.snapshot())?.password_hash).toBe("original");
    expect(await f.sessions()).toBe(1);expect(await f.codes()).toBe(1);
  });
  it("promoção global para Superadmin durante reset preserva a identidade", async () => {
    const f = await fixture();
    const racing = beforeBatch(()=>db.prepare("UPDATE users SET platform_role='superadmin' WHERE id=?1").bind(f.userId).run());
    expect(await updateTeamAccess(racing,f.companyId,f.before,f.next)).toBe(false);
    expect((await f.snapshot())?.password_hash).toBe("original");
    expect(await f.sessions()).toBe(1);expect(await f.codes()).toBe(1);
  });
  it("promoção para dono durante remoção não é sobrescrita por snapshot antigo", async () => {
    const f = await fixture();
    const racing = beforeBatch(()=>db.prepare("UPDATE company_memberships SET role='owner' WHERE id=?1").bind(f.membershipId).run());
    expect(await updateTeamAccess(racing,f.companyId,f.before,{...f.next,active:0,passwordHash:undefined})).toBe(false);
    expect(await f.snapshot()).toMatchObject({role:"owner",active:1});expect(await f.sessions()).toBe(1);
  });
  it("senha alterada em paralelo impede reset baseado em credencial antiga", async () => {
    const f = await fixture();
    const racing = beforeBatch(()=>db.prepare("UPDATE users SET password_hash='changed-in-parallel' WHERE id=?1").bind(f.userId).run());
    expect(await updateTeamAccess(racing,f.companyId,f.before,f.next)).toBe(false);
    expect((await f.snapshot())?.password_hash).toBe("changed-in-parallel");
    expect(await f.sessions()).toBe(1);expect(await f.codes()).toBe(1);
  });
  it("dois resets do mesmo snapshot só permitem uma operação vencedora", async () => {
    const f = await fixture();
    const results = await Promise.all([f.next,{...f.next,passwordHash:crypto.randomUUID()}].map(next=>updateTeamAccess(db,f.companyId,f.before,next)));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await f.sessions()).toBe(0);expect(await f.codes()).toBe(0);
  });
  it("falha ao invalidar código reverte senha, vínculo e sessões", async () => {
    const f = await fixture(), trigger = `reset_fail_${f.userId}`;
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE UPDATE ON password_resets WHEN NEW.user_id=${f.userId} BEGIN SELECT RAISE(ABORT,'test reset rollback'); END`).run();
    try {await expect(updateTeamAccess(db,f.companyId,f.before,{...f.next,role:"manager",barberId:null})).rejects.toThrow(/test reset rollback/);}
    finally {await db.prepare(`DROP TRIGGER ${trigger}`).run();}
    expect(await f.snapshot()).toEqual(f.before);
    expect(await f.sessions()).toBe(1);expect(await f.codes()).toBe(1);
  });
  it("reativação revalida profissional e conta global no commit", async () => {
    for (const target of ["barber","user"]) {
      const f = await fixture();
      await db.prepare("UPDATE company_memberships SET active=0 WHERE id=?1").bind(f.membershipId).run();
      const before = (await f.snapshot())!;
      const racing = beforeBatch(()=>db.prepare(target==="barber"?"UPDATE barbers SET active=0 WHERE id=?1":"UPDATE users SET active=0 WHERE id=?1").bind(target==="barber"?f.barberId:f.userId).run());
      expect(await updateTeamAccess(racing,f.companyId,before,{...f.next,passwordHash:undefined,validateBarber:true,validateUser:true})).toBe(false);
      expect((await f.snapshot())?.active).toBe(0);
    }
  });
});
