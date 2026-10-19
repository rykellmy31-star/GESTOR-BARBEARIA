import { nowIso } from "./utils";

/** A senha validada precisa continuar atual ao confirmar a troca. */
export async function changePasswordAtomically(db:D1Database,userId:number,expectedHash:string,newHash:string) {
  const results=await db.batch([
    db.prepare("UPDATE users SET password_hash=?1,must_change_password=0 WHERE id=?2 AND active=1 AND password_hash=?3")
      .bind(newHash,userId,expectedHash),
    db.prepare(`DELETE FROM sessions WHERE user_id=?1 AND EXISTS(
      SELECT 1 FROM users WHERE id=?1 AND password_hash=?2)`)
      .bind(userId,newHash),
    db.prepare(`UPDATE password_resets SET used_at=?1 WHERE user_id=?2 AND used_at IS NULL
      AND EXISTS(SELECT 1 FROM users WHERE id=?2 AND password_hash=?3)`)
      .bind(nowIso(),userId,newHash),
  ]);
  return results[0].meta.changes===1;
}
