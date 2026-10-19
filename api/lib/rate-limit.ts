import { sha256hex } from "./crypto";

/** Uma janela por chave, consumida atomicamente no D1, inclusive entre Workers. */
export async function persistentRateLimit(
  db: D1Database, secret: string, key: string, limit: number, windowMs: number, now = Date.now(),
): Promise<boolean> {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1)
    throw new Error("Limite inválido");
  const fingerprint = await sha256hex(`tigu-request-limit:${secret}:${key}`);
  const row = await db.prepare(`INSERT INTO request_rate_limits (fingerprint,attempts,reset_at)
    VALUES (?1,1,?2)
    ON CONFLICT(fingerprint) DO UPDATE SET
      attempts=CASE WHEN reset_at<=?3 THEN 1 ELSE attempts+1 END,
      reset_at=CASE WHEN reset_at<=?3 THEN ?2 ELSE reset_at END
    WHERE reset_at<=?3 OR attempts<?4
    RETURNING attempts`)
    .bind(fingerprint,now+windowMs,now,limit).first<{attempts:number}>();
  return Boolean(row);
}

export async function purgeRequestRateLimits(db: D1Database, now = Date.now()) {
  // Mantém uma tolerância de um dia; jamais remove uma janela ainda ativa.
  return db.prepare("DELETE FROM request_rate_limits WHERE reset_at<?1")
    .bind(now-86400000).run();
}
