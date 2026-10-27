import { nowIso } from "./utils";

export interface TeamMemberSnapshot {
  id: number;
  user_id: number;
  role: string;
  barber_id: number | null;
  active: number;
  password_hash: string;
}

/** A senha nova deve ter hash com salt novo, gerado para esta operação. */
export async function updateTeamAccess(db: D1Database, companyId: number, before: TeamMemberSnapshot,
  next: { role: "manager" | "barber"; barberId: number | null; active: number;
    validateBarber: boolean; validateUser: boolean; passwordHash?: string }) {
  const at = nowIso();
  const statements = [db.prepare(`UPDATE company_memberships
    SET role=?1,barber_id=?2,active=?3
    WHERE id=?4 AND company_id=?5 AND user_id=?6 AND role=?7 AND barber_id IS ?8 AND active=?9 AND role<>'owner'
    AND (?10=0 OR EXISTS(SELECT 1 FROM barbers WHERE id=?2 AND company_id=?5 AND active=1))
    AND (?11=0 OR EXISTS(SELECT 1 FROM users WHERE id=?6 AND active=1))
    AND (?12 IS NULL OR (
      EXISTS(SELECT 1 FROM users WHERE id=?6 AND active=1 AND platform_role='user' AND password_hash=?13)
      AND NOT EXISTS(SELECT 1 FROM company_memberships WHERE user_id=?6 AND company_id<>?5)))`)
    .bind(next.role,next.barberId,next.active,before.id,companyId,before.user_id,before.role,before.barber_id,
      before.active,next.validateBarber?1:0,next.validateUser?1:0,next.passwordHash??null,before.password_hash)];
  if (next.passwordHash) {
    statements.push(
      db.prepare("UPDATE users SET password_hash=?1,must_change_password=1 WHERE id=?2 AND changes()=1")
        .bind(next.passwordHash,before.user_id),
      db.prepare(`DELETE FROM sessions WHERE user_id=?1 AND EXISTS(SELECT 1 FROM users WHERE id=?1 AND password_hash=?2)`)
        .bind(before.user_id,next.passwordHash),
      db.prepare(`UPDATE password_resets SET used_at=?1 WHERE user_id=?2 AND used_at IS NULL
        AND EXISTS(SELECT 1 FROM users WHERE id=?2 AND password_hash=?3)`)
        .bind(at,before.user_id,next.passwordHash),
    );
  } else if (next.active === 0) {
    statements.push(db.prepare("DELETE FROM sessions WHERE user_id=?1 AND changes()=1").bind(before.user_id));
  }
  const result = await db.batch(statements);
  return result[0].meta.changes === 1 && (!next.passwordHash || result[1].meta.changes === 1);
}
