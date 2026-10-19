import { nowIso } from "./utils";

type NewTeamAccount = {
  companyId: number;
  name: string;
  email: string;
  passwordHash: string;
  role: "manager" | "barber";
  barberId: number | null;
  welcomeTitle?: string;
};

/** Conta nova, vínculo e aviso opcional são gravados na mesma transação. */
export async function createTeamAccount(db: D1Database, input: NewTeamAccount) {
  const { companyId, name, email, passwordHash, role, welcomeTitle } = input;
  const barberId = role === "barber" ? input.barberId : null;
  if (role === "barber" && !barberId) return { ok: false as const, message: "Vincule um profissional ativo ao acesso." };
  const at = nowIso();
  const statements = [
    db.prepare(`INSERT INTO users(platform_role,name,email,password_hash,active,must_change_password,created_at)
      SELECT 'user',?2,?3,?4,1,1,?5 FROM companies c
      WHERE c.id=?1 AND c.status='active' AND (?6 IS NULL OR EXISTS(
        SELECT 1 FROM barbers b WHERE b.id=?6 AND b.company_id=c.id AND b.active=1))`)
      .bind(companyId,name,email,passwordHash,at,barberId),
    db.prepare(`INSERT INTO company_memberships(company_id,user_id,role,barber_id,active,created_at)
      SELECT ?1,u.id,?4,?5,1,?6 FROM users u WHERE u.email=?2 AND u.password_hash=?3 AND changes()=1`)
      .bind(companyId,email,passwordHash,role,barberId,at),
  ];
  if (welcomeTitle) statements.push(db.prepare(`INSERT INTO notifications(company_id,audience,user_id,title,body,kind)
    SELECT ?1,'barber',u.id,?4,'Guarde seu e-mail e senha; o painel do profissional abre em /painel.','system'
    FROM users u JOIN company_memberships m ON m.user_id=u.id AND m.company_id=?1
    WHERE u.email=?2 AND u.password_hash=?3 AND changes()=1`)
    .bind(companyId,email,passwordHash,welcomeTitle));
  try {
    const result = await db.batch(statements);
    if (result[0].meta.changes !== 1 || result[1].meta.changes !== 1)
      return { ok: false as const, message: "Os dados da empresa ou do profissional mudaram. Atualize a página e tente novamente." };
    return { ok: true as const, userId: Number(result[0].meta.last_row_id) };
  } catch (error) {
    if (/UNIQUE constraint failed: users\.email/i.test(String(error)))
      return { ok: false as const, message: "Este e-mail já possui conta. Solicite ao suporte o vínculo seguro do acesso existente." };
    throw error;
  }
}
