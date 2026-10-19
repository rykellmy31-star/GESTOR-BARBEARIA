/** Consome o código e troca a senha na mesma transação D1.
 * changes() vincula cada escrita ao resultado da instrução anterior;
 * used_at sozinho não distingue concorrentes no mesmo segundo.
 */
export async function consumePasswordReset(
  db: D1Database,
  input: { resetId: number; userId: number; codeHash: string; passwordHash: string; at: string },
): Promise<boolean> {
  const { resetId, userId, codeHash, passwordHash, at } = input;
  const results = await db.batch([
    db.prepare(`UPDATE password_resets SET used_at=?1
      WHERE id=?2 AND user_id=?3 AND code_hash=?4 AND used_at IS NULL
      AND attempts<5 AND expires_at>?1`)
      .bind(at, resetId, userId, codeHash),
    db.prepare(`UPDATE users SET password_hash=?1,must_change_password=0
      WHERE id=?2 AND active=1 AND changes()=1`)
      .bind(passwordHash, userId),
    db.prepare(`DELETE FROM sessions WHERE user_id=?1 AND changes()=1`)
      .bind(userId),
  ]);
  return results[0].meta.changes === 1 && results[1].meta.changes === 1;
}
