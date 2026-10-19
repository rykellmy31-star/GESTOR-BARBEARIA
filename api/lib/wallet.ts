// ============================================================================
// CARTEIRA DE CRÉDITOS (por empresa) — contadores SEMPRE no servidor.
// Invariantes garantidas por SQL (CHECK no schema + guards nas queries):
//   balance >= 0 (trava anti-negativo, salvo allow_negative explícito);
//   reserved nunca ultrapassa balance quando allow_negative = 0;
//   toda mutação gera lançamento IMUTÁVEL com idempotency_key única.
// Padrão "gate": uma UPDATE condiciona o estado-fonte (job/pedido); a
// transação do ledger só é escrita se o gate pegou. Idempotência pela chave.
// ============================================================================
import { nowIso } from "./utils";

export interface WalletRow {
  company_id: number;
  balance_cents: number;
  reserved_cents: number;
  allow_negative: number;
  low_balance_alert_cents: number;
  lifetime_charged_cents: number;
  lifetime_recharged_cents: number;
}

export async function getWallet(db: D1Database, companyId: number): Promise<WalletRow | null> {
  return db.prepare(`SELECT * FROM wallets WHERE company_id = ?1`).bind(companyId).first<WalletRow>();
}

export async function ensureWallet(db: D1Database, companyId: number): Promise<WalletRow> {
  await db.prepare(`INSERT OR IGNORE INTO wallets (company_id, updated_at) VALUES (?1, ?2)`).bind(companyId, nowIso()).run();
  return (await getWallet(db, companyId))!;
}

/** Reserva créditos p/ job agendado (dinheiro fica "empenhado", não gasto). */
export async function reserveForJob(
  db: D1Database,
  companyId: number,
  jobId: number,
  priceCents: number,
  _allowNegative: boolean
): Promise<{ ok: boolean; reason?: "insufficient_funds" }> {
  if (!Number.isInteger(priceCents) || priceCents < 0) return { ok: false, reason: "insufficient_funds" };
  if (priceCents === 0) return { ok: true };
  const job = await db.prepare(
    `SELECT reserved_cents, status, captured_at, refunded_at, price_cents FROM message_jobs WHERE id=?1 AND company_id=?2`
  ).bind(jobId, companyId).first<{ reserved_cents: number; status: string; captured_at: string | null; refunded_at: string | null; price_cents: number }>();
  if (!job || job.price_cents !== priceCents || job.captured_at || job.refunded_at ||
      !["scheduled", "blocked_funds"].includes(job.status)) {
    return { ok: false, reason: "insufficient_funds" };
  }
  if (job.reserved_cents === priceCents) return { ok: true };
  if (job.reserved_cents !== 0) return { ok: false, reason: "insufficient_funds" };

  await ensureWallet(db, companyId);
  const now = nowIso();
  const idem = `reserve:job-${jobId}`;
  try {
    // Batch D1 transacional. O lançamento UNIQUE é o gate contra duplo reserve;
    // wallet CHECK provoca rollback caso não exista saldo livre.
    await db.batch([
      db.prepare(
        `INSERT INTO wallet_transactions (company_id,type,amount_cents,balance_after,reserved_after,
         ref_type,ref_id,idempotency_key,note,created_at)
         SELECT ?1,'reserve',0,w.balance_cents,w.reserved_cents,'message_job',?2,?3,
         'Reserva de créditos para lembrete',?4
         FROM wallets w JOIN message_jobs j ON j.id=?5 AND j.company_id=w.company_id
         WHERE w.company_id=?1 AND j.reserved_cents=0 AND j.captured_at IS NULL
         AND j.refunded_at IS NULL AND j.status IN ('scheduled','blocked_funds')`
      ).bind(companyId, `job-${jobId}`, idem, now, jobId),
      db.prepare(
        `UPDATE wallets SET reserved_cents=CASE
         WHEN EXISTS (SELECT 1 FROM wallet_transactions WHERE idempotency_key=?1)
         THEN reserved_cents+?2 ELSE -1 END, updated_at=?3 WHERE company_id=?4`
      ).bind(idem, priceCents, now, companyId),
      db.prepare(
        `UPDATE message_jobs SET reserved_cents=?1,reservation_key=?2,updated_at=?3
         WHERE id=?4 AND company_id=?5 AND reserved_cents=0 AND status IN ('scheduled','blocked_funds')`
      ).bind(priceCents, idem, now, jobId, companyId),
      db.prepare(
        `UPDATE wallet_transactions SET
         balance_after=(SELECT balance_cents FROM wallets WHERE company_id=?1),
         reserved_after=(SELECT reserved_cents FROM wallets WHERE company_id=?1)
         WHERE company_id=?1 AND idempotency_key=?2`
      ).bind(companyId, idem),
    ]);
    return { ok: true };
  } catch {
    const current = await db.prepare(`SELECT reserved_cents FROM message_jobs WHERE id=?1 AND company_id=?2`)
      .bind(jobId, companyId).first<{ reserved_cents: number }>();
    if (current?.reserved_cents === priceCents) return { ok: true };
    return { ok: false, reason: "insufficient_funds" };
  }
}

/** Libera reserva com lançamento e saldo na mesma transação. */
export async function releaseJobReservation(db: D1Database, companyId: number, jobId: number, _priceCents: number): Promise<boolean> {
  const job = await db.prepare(
    `SELECT reserved_cents FROM message_jobs WHERE id=?1 AND company_id=?2
     AND captured_at IS NULL AND refunded_at IS NULL AND status NOT IN ('sent','delivered','read')`
  ).bind(jobId, companyId).first<{ reserved_cents: number }>();
  if (!job || job.reserved_cents <= 0) return false;

  const now = nowIso();
  const idem = `release:job-${jobId}`;
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO wallet_transactions (company_id,type,amount_cents,balance_after,reserved_after,
         ref_type,ref_id,idempotency_key,note,created_at)
         SELECT ?1,'release',0,w.balance_cents,w.reserved_cents,'message_job',?2,?3,
         'Reserva liberada sem cobrança',?4
         FROM wallets w JOIN message_jobs j ON j.id=?5 AND j.company_id=w.company_id
         WHERE w.company_id=?1 AND j.reserved_cents>0 AND j.captured_at IS NULL AND j.refunded_at IS NULL`
      ).bind(companyId, `job-${jobId}`, idem, now, jobId),
      db.prepare(
        `UPDATE wallets SET reserved_cents=CASE
         WHEN EXISTS (SELECT 1 FROM wallet_transactions WHERE idempotency_key=?1)
         THEN reserved_cents-?2 ELSE -1 END, updated_at=?3 WHERE company_id=?4`
      ).bind(idem, job.reserved_cents, now, companyId),
      db.prepare(
        `UPDATE message_jobs SET reserved_cents=0,refunded_at=?1,updated_at=?1
         WHERE id=?2 AND company_id=?3 AND captured_at IS NULL AND refunded_at IS NULL AND status NOT IN ('sent','delivered','read') AND status NOT IN ('sent','delivered','read')`
      ).bind(now, jobId, companyId),
      db.prepare(
        `UPDATE wallet_transactions SET balance_after=(SELECT balance_cents FROM wallets WHERE company_id=?1),
         reserved_after=(SELECT reserved_cents FROM wallets WHERE company_id=?1)
         WHERE company_id=?1 AND idempotency_key=?2`
      ).bind(companyId, idem),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Captura a cobrança (consume) de um job aceito. Idempotente via captured_at + chave. */
export async function captureJobCharge(db: D1Database, companyId: number, jobId: number, priceCents: number): Promise<boolean> {
  const job = await db.prepare(
    `SELECT price_cents, reserved_cents, captured_at, refunded_at, status FROM message_jobs
     WHERE id=?1 AND company_id=?2`
  ).bind(jobId, companyId).first<{ price_cents: number; reserved_cents: number; captured_at: string | null; refunded_at: string | null; status: string }>();
  if (!job || job.captured_at || job.refunded_at ||
      !["sending", "sent", "delivered", "read", "failed"].includes(job.status) ||
      job.price_cents !== priceCents || job.reserved_cents < priceCents) return false;
  await ensureWallet(db, companyId);
  const now = nowIso(), idem = `capture:job-${jobId}`;
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO wallet_transactions (company_id,type,amount_cents,balance_after,reserved_after,
         ref_type,ref_id,idempotency_key,note,created_at)
         SELECT ?1,'capture',-?2,w.balance_cents,w.reserved_cents,'message_job',?3,?4,
         'Mensagem cobrada (aceita no provedor)',?5 FROM wallets w WHERE w.company_id=?1`
      ).bind(companyId, priceCents, `job-${jobId}`, idem, now),
      db.prepare(
        `UPDATE wallets SET balance_cents=balance_cents-?1,
         reserved_cents=reserved_cents-?1,
         lifetime_charged_cents=lifetime_charged_cents+?1,updated_at=?2 WHERE company_id=?3`
      ).bind(priceCents, now, companyId),
      db.prepare(
        `UPDATE message_jobs SET captured_at=?1,reserved_cents=0,updated_at=?1
         WHERE id=?2 AND company_id=?3 AND captured_at IS NULL`
      ).bind(now, jobId, companyId),
      db.prepare(
        `UPDATE wallet_transactions SET balance_after=(SELECT balance_cents FROM wallets WHERE company_id=?1),
         reserved_after=(SELECT reserved_cents FROM wallets WHERE company_id=?1)
         WHERE company_id=?1 AND idempotency_key=?2`
      ).bind(companyId, idem),
    ]);
    return true;
  } catch {
    return false;
  }
}

/** Estorno de mensagem com lançamento imutável e alteração atômica de saldo. */
export async function refundJobCharge(
  db: D1Database,
  companyId: number,
  jobId: number,
  priceCents: number,
  note = "",
  byUserId: number | null = null
): Promise<boolean> {
  const job = await db.prepare(
    `SELECT price_cents, captured_at, refunded_at FROM message_jobs WHERE id=?1 AND company_id=?2`
  ).bind(jobId, companyId).first<{ price_cents: number; captured_at: string | null; refunded_at: string | null }>();
  if (!job || !job.captured_at || job.refunded_at || job.price_cents !== priceCents) return false;
  const now = nowIso(), idem = `refund:job-${jobId}`;
  try {
    await db.batch([
      db.prepare(
        `INSERT INTO wallet_transactions (company_id,type,amount_cents,balance_after,reserved_after,
         ref_type,ref_id,idempotency_key,note,created_by,created_at)
         SELECT ?1,'refund',?2,w.balance_cents,w.reserved_cents,'message_job',?3,?4,?5,?6,?7
         FROM wallets w WHERE w.company_id=?1`
      ).bind(companyId, priceCents, `job-${jobId}`, idem, note || "Reembolso de mensagem", byUserId, now),
      db.prepare(
        `UPDATE wallets SET balance_cents=balance_cents+?1,
         lifetime_charged_cents=MAX(0,lifetime_charged_cents-?1),
         updated_at=?2 WHERE company_id=?3`
      ).bind(priceCents, now, companyId),
      db.prepare(
        `UPDATE message_jobs SET refunded_at=?1,updated_at=?1 WHERE id=?2 AND company_id=?3 AND refunded_at IS NULL`
      ).bind(now, jobId, companyId),
      db.prepare(
        `UPDATE wallet_transactions SET balance_after=(SELECT balance_cents FROM wallets WHERE company_id=?1),
         reserved_after=(SELECT reserved_cents FROM wallets WHERE company_id=?1)
         WHERE company_id=?1 AND idempotency_key=?2`
      ).bind(companyId, idem),
    ]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Crédito de recarga — SÓ chamado após pagamento confirmado PELO PROVEDOR
 * (webhook re-consultado). Gate: topup ainda não creditada. 100% idempotente.
 */
export async function creditTopup(db: D1Database, companyId: number, amountCents: number, topupOrderId: number, note = "Recarga Pix confirmada"): Promise<boolean> {
  const order = await db.prepare(
    `SELECT status, amount_cents, credited_at FROM topup_orders WHERE id=?1 AND company_id=?2`
  ).bind(topupOrderId, companyId).first<{ status: string; amount_cents: number; credited_at: string | null }>();
  if (!order || !["pending", "expired"].includes(order.status) || order.credited_at !== null) return false;
  // Valor obrigatório é o do pedido salvo no banco; nunca creditar montante arbitrário do chamador.
  if (!Number.isInteger(amountCents) || order.amount_cents !== amountCents || amountCents <= 0) return false;
  await ensureWallet(db, companyId);

  const now = nowIso();
  const idem = `topup:${topupOrderId}`;
  try {
    // Se houver confirmação concorrente, o UNIQUE(idempotency_key) faz o
    // segundo batch falhar por completo: sem crédito duplicado no saldo.
    await db.batch([
      db.prepare(
        `INSERT INTO wallet_transactions (company_id, type, amount_cents, balance_after,
         reserved_after, ref_type, ref_id, idempotency_key, note, created_at)
         SELECT ?1,'topup',?2,w.balance_cents,w.reserved_cents,'topup_order',CAST(?3 AS TEXT),?4,?5,?6
         FROM wallets w WHERE w.company_id=?1`
      ).bind(companyId, amountCents, topupOrderId, idem, note, now),
      db.prepare(
        `UPDATE wallets SET balance_cents=balance_cents+?1,
         lifetime_recharged_cents=lifetime_recharged_cents+?1, updated_at=?2 WHERE company_id=?3`
      ).bind(amountCents, now, companyId),
      db.prepare(
        `UPDATE wallet_transactions SET
         balance_after=(SELECT balance_cents FROM wallets WHERE company_id=?1),
         reserved_after=(SELECT reserved_cents FROM wallets WHERE company_id=?1)
         WHERE company_id=?1 AND idempotency_key=?2`
      ).bind(companyId, idem),
      db.prepare(
        `UPDATE topup_orders SET status='paid', paid_at=COALESCE(paid_at,?1),
         credited_at=?1, credited_tx_id=(SELECT id FROM wallet_transactions WHERE idempotency_key=?2),
         updated_at=?1 WHERE id=?3 AND company_id=?4 AND status IN ('pending','expired')`
      ).bind(now, idem, topupOrderId, companyId),
    ]);
    return true;
  } catch (e) {
    const existing = await db.prepare(`SELECT id FROM wallet_transactions WHERE idempotency_key=?1`).bind(idem).first();
    if (existing) return false;
    throw e;
  }
}

/** Ajuste manual do superadmin — justificativa obrigatória, auditado, idempotente. */
export async function manualAdjustment(
  db: D1Database,
  companyId: number,
  deltaCents: number,
  justification: string,
  byUserId: number,
  key: string
): Promise<{ ok: boolean; error?: string }> {
  if (!justification || justification.trim().length < 10) return { ok: false, error: "Justificativa obrigatória (mín. 10 caracteres)." };
  if (!Number.isInteger(deltaCents) || deltaCents === 0 || Math.abs(deltaCents) > 100_000_000) return { ok: false, error: "Valor inválido." };
  if (!key || key.length > 120) return { ok: false, error: "Chave de idempotência inválida." };

  const wallet = await getWallet(db, companyId);
  if (!wallet) return { ok: false, error: "Carteira não encontrada." };
  // Protege o saldo já reservado por envios pendentes.
  if (wallet.allow_negative !== 1 && wallet.balance_cents + deltaCents < wallet.reserved_cents) {
    return { ok: false, error: "Saldo livre insuficiente para este ajuste." };
  }

  const now = nowIso();
  const idem = `adjust:${key}`;
  try {
    // Uma única transação D1: um lançamento repetido falha no UNIQUE e
    // NENHUM saldo é alterado. CHECKs do banco fazem rollback de saldos inválidos.
    await db.batch([
      db.prepare(
        `INSERT INTO wallet_transactions
          (company_id, type, amount_cents, balance_after, reserved_after, ref_type, ref_id,
           idempotency_key, note, created_by, created_at)
         SELECT ?1,'adjust',?2,w.balance_cents,w.reserved_cents,'manual','adjust',?3,?4,?5,?6
         FROM wallets w WHERE w.company_id=?1`
      ).bind(companyId, deltaCents, idem, justification.trim(), byUserId, now),
      db.prepare(
        `UPDATE wallets SET balance_cents = balance_cents + ?1,
         lifetime_recharged_cents = lifetime_recharged_cents + CASE WHEN ?1 > 0 THEN ?1 ELSE 0 END,
         updated_at = ?2 WHERE company_id = ?3`
      ).bind(deltaCents, now, companyId),
      db.prepare(
        `UPDATE wallet_transactions SET
         balance_after=(SELECT balance_cents FROM wallets WHERE company_id=?1),
         reserved_after=(SELECT reserved_cents FROM wallets WHERE company_id=?1)
         WHERE company_id=?1 AND idempotency_key=?2`
      ).bind(companyId, idem),
    ]);
    return { ok: true };
  } catch (e) {
    const existing = await db.prepare(`SELECT id FROM wallet_transactions WHERE idempotency_key=?1`).bind(idem).first();
    if (existing) return { ok: false, error: "Ajuste duplicado (nenhuma alteração aplicada)." };
    return { ok: false, error: "Não foi possível aplicar o ajuste. Saldo ou transação inválida." };
  }
}


/**
 * Encerramento manual de um envio incerto após confirmação externa de que
 * ele NÃO saiu. O lançamento de devolução e o encerramento são atômicos.
 */
export async function resolveUncertainNotSent(
  db: D1Database, companyId: number, jobId: number,
  operatorId: number, evidence: string
): Promise<{ ok: boolean; error?: string }> {
  const note = evidence.trim();
  if (![companyId, jobId, operatorId].every(n => Number.isSafeInteger(n) && n > 0) ||
      note.length < 20 || note.length > 500)
    return { ok: false, error: "Dados inválidos ou evidência fora de 20 a 500 caracteres." };

  const j = await db.prepare(
    "SELECT status,provider_msg_id,captured_at,refunded_at,reserved_cents,price_cents,last_attempt_at FROM message_jobs WHERE id=?1 AND company_id=?2"
  ).bind(jobId, companyId).first<{
    status: string; provider_msg_id: string; captured_at: string | null;
    refunded_at: string | null; reserved_cents: number; price_cents: number;
    last_attempt_at: string | null;
  }>();
  if (!j || j.status !== "sending" || j.provider_msg_id ||
      j.captured_at || j.refunded_at || !j.last_attempt_at ||
      Date.parse(j.last_attempt_at) > Date.now() - 10 * 60000 ||
      j.reserved_cents < 0 || j.reserved_cents > j.price_cents)
    return { ok: false, error: "Mensagem não elegível para encerramento manual." };

  await ensureWallet(db, companyId);
  const at = nowIso();
  const key = "release:job-" + jobId;
  const marker = "Encerrado sem envio após confirmação externa";
  try {
    const result = await db.batch([
      db.prepare(
        "UPDATE message_jobs SET status='failed',last_error=?1,next_attempt_at=NULL,reserved_cents=0,refunded_at=CASE WHEN reserved_cents>0 THEN ?2 ELSE refunded_at END,updated_at=?2 WHERE id=?3 AND company_id=?4 AND status='sending' AND provider_msg_id='' AND captured_at IS NULL AND refunded_at IS NULL AND last_attempt_at <= strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes') AND reserved_cents=?5"
      ).bind(marker, at, jobId, companyId, j.reserved_cents),
      db.prepare(
        "INSERT INTO wallet_transactions (company_id,type,amount_cents,balance_after,reserved_after,ref_type,ref_id,idempotency_key,note,created_by,created_at) SELECT ?1,'release',0,w.balance_cents,w.reserved_cents,'message_job',?2,?3,?4,?5,?6 FROM wallets w JOIN message_jobs m ON m.company_id=w.company_id WHERE w.company_id=?1 AND m.id=?7 AND m.status='failed' AND m.last_error=?8 AND m.updated_at=?6"
      ).bind(companyId, "job-" + jobId, key, note, operatorId, at, jobId, marker),
      db.prepare(
        "UPDATE wallets SET reserved_cents=reserved_cents-?1, updated_at=?2 WHERE company_id=?3 AND EXISTS (SELECT 1 FROM message_jobs m WHERE m.id=?4 AND m.company_id=?3 AND m.status='failed' AND m.last_error=?5 AND m.updated_at=?2) AND EXISTS (SELECT 1 FROM wallet_transactions t WHERE t.idempotency_key=?6)"
      ).bind(j.reserved_cents, at, companyId, jobId, marker, key),
      db.prepare(
        "UPDATE wallet_transactions SET balance_after=(SELECT balance_cents FROM wallets WHERE company_id=?1),reserved_after=(SELECT reserved_cents FROM wallets WHERE company_id=?1) WHERE company_id=?1 AND idempotency_key=?2"
      ).bind(companyId, key),
      db.prepare(
        "INSERT INTO audit_log (company_id,scope,user_id,user_name,action,entity,entity_id,meta) SELECT ?1,'platform',?2,COALESCE((SELECT name FROM users WHERE id=?2),'operador'),'message.not_sent_confirmed','message_job',?3,?4 WHERE EXISTS (SELECT 1 FROM message_jobs m WHERE m.id=?3 AND m.company_id=?1 AND m.status='failed' AND m.last_error=?5 AND m.updated_at=?6)"
      ).bind(companyId, operatorId, String(jobId), JSON.stringify({ evidence: note, released_cents: j.reserved_cents }), marker, at),
    ]);
    if (result[0].meta?.changes !== 1 || result[1].meta?.changes !== 1 ||
        result[2].meta?.changes !== 1 || result[4].meta?.changes !== 1)
      return { ok: false, error: "Estado inconsistente: solicitar conferência de saldo e extrato." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Encerramento não aplicado; verifique se a mensagem já foi resolvida." };
  }
}
