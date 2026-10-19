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
  allowNegative: boolean
): Promise<{ ok: boolean; reason?: "insufficient_funds" }> {
  const guard = allowNegative ? `1 = 1` : `balance_cents - reserved_cents >= ?1`;
  const res = await db
    .prepare(`UPDATE wallets SET reserved_cents = reserved_cents + ?1, updated_at = ?2 WHERE company_id = ?3 AND ${guard}`)
    .bind(priceCents, nowIso(), companyId)
    .run();
  if (!res.meta?.changes) return { ok: false, reason: "insufficient_funds" };
  await db
    .prepare(
      `INSERT OR IGNORE INTO wallet_transactions (company_id, type, amount_cents, balance_after, reserved_after, ref_type, ref_id, idempotency_key, note, created_at)
       SELECT ?1,'reserve',0,w.balance_cents,w.reserved_cents,'message_job','job-'||?2,?3,'Reserva p/ envio agendado',?4 FROM wallets w WHERE w.company_id=?1`
    )
    .bind(companyId, jobId, `reserve:job-${jobId}`, nowIso())
    .run();
  return { ok: true };
}

/** Libera reserva sem cobrar (falha permanente / cancelado antes do envio). */
export async function releaseJobReservation(db: D1Database, companyId: number, jobId: number, priceCents: number): Promise<boolean> {
  const now = nowIso();
  const gate = await db
    .prepare(`UPDATE message_jobs SET refunded_at = ?1 WHERE id = ?2 AND refunded_at IS NULL AND reserved_cents > 0 AND captured_at IS NULL`)
    .bind(now, jobId)
    .run();
  if (!gate.meta?.changes) return false;
  await db.batch([
    db.prepare(`UPDATE wallets SET reserved_cents = MAX(0, reserved_cents - ?1), updated_at = ?2 WHERE company_id = ?3`).bind(priceCents, now, companyId),
    db.prepare(
      `INSERT OR IGNORE INTO wallet_transactions (company_id, type, amount_cents, balance_after, reserved_after, ref_type, ref_id, idempotency_key, note, created_at)
       SELECT ?1,'release',0,w.balance_cents,w.reserved_cents,'message_job','job-'||?2,?3,'Reserva liberada sem cobrança',?4 FROM wallets w WHERE w.company_id=?1`
    ).bind(companyId, jobId, `release:job-${jobId}`, now),
  ]);
  return true;
}

/** Captura a cobrança (consume) de um job aceito. Idempotente via captured_at + chave. */
export async function captureJobCharge(db: D1Database, companyId: number, jobId: number, priceCents: number): Promise<boolean> {
  const now = nowIso();
  const gate = await db
    .prepare(`UPDATE message_jobs SET captured_at = ?1 WHERE id = ?2 AND captured_at IS NULL AND status IN ('sending','sent','delivered','read','failed')`)
    .bind(now, jobId)
    .run();
  if (!gate.meta?.changes) return false;
  await db.batch([
    db
      .prepare(`UPDATE wallets SET balance_cents = balance_cents - ?1, reserved_cents = MAX(0, reserved_cents - ?1), lifetime_charged_cents = lifetime_charged_cents + ?1, updated_at = ?2 WHERE company_id = ?3`)
      .bind(priceCents, now, companyId),
    db.prepare(
      `INSERT OR IGNORE INTO wallet_transactions (company_id, type, amount_cents, balance_after, reserved_after, ref_type, ref_id, idempotency_key, note, created_at)
       SELECT ?1,'capture',-?2,w.balance_cents,w.reserved_cents,'message_job','job-'||?3,?4,'Mensagem cobrada (aceita no provedor)',?5 FROM wallets w WHERE w.company_id=?1`
    ).bind(companyId, priceCents, jobId, `capture:job-${jobId}`, now),
  ]);
  return true;
}

/** Estorno pós-cobrança (falha de entrega com política delivered / decisão do super). */
export async function refundJobCharge(
  db: D1Database,
  companyId: number,
  jobId: number,
  priceCents: number,
  note = "",
  byUserId: number | null = null
): Promise<boolean> {
  const now = nowIso();
  const gate = await db
    .prepare(`UPDATE message_jobs SET refunded_at = ?1 WHERE id = ?2 AND captured_at IS NOT NULL AND refunded_at IS NULL`)
    .bind(now, jobId)
    .run();
  if (!gate.meta?.changes) return false;
  await db.batch([
    db
      .prepare(`UPDATE wallets SET balance_cents = balance_cents + ?1, lifetime_charged_cents = MAX(0, lifetime_charged_cents - ?1), updated_at = ?2 WHERE company_id = ?3`)
      .bind(priceCents, now, companyId),
    db.prepare(
      `INSERT OR IGNORE INTO wallet_transactions (company_id, type, amount_cents, balance_after, reserved_after, ref_type, ref_id, idempotency_key, note, created_by, created_at)
       SELECT ?1,'refund',?2,w.balance_cents,w.reserved_cents,'message_job','job-'||?3,?4,?5,?6,?7 FROM wallets w WHERE w.company_id=?1`
    ).bind(companyId, priceCents, jobId, `refund:job-${jobId}`, note || "Reembolso de cobrança de mensagem", byUserId, now),
  ]);
  return true;
}

/**
 * Crédito de recarga — SÓ chamado após pagamento confirmado PELO PROVEDOR
 * (webhook re-consultado). Gate: topup ainda não creditada. 100% idempotente.
 */
export async function creditTopup(db: D1Database, companyId: number, amountCents: number, topupOrderId: number, note = "Recarga Pix confirmada"): Promise<boolean> {
  const now = nowIso();
  const gate = await db
    .prepare(`UPDATE topup_orders SET status = 'paid', credited_at = ?1, paid_at = COALESCE(paid_at, ?1) WHERE id = ?2 AND company_id = ?3 AND status IN ('pending','expired')`)
    .bind(now, topupOrderId, companyId)
    .run();
  if (!gate.meta?.changes) return false;
  await db.batch([
    db
      .prepare(`UPDATE wallets SET balance_cents = balance_cents + ?1, lifetime_recharged_cents = lifetime_recharged_cents + ?1, updated_at = ?2 WHERE company_id = ?3`)
      .bind(amountCents, now, companyId),
    db.prepare(
      `INSERT OR IGNORE INTO wallet_transactions (company_id, type, amount_cents, balance_after, reserved_after, ref_type, ref_id, idempotency_key, note, created_at)
       SELECT ?1,'topup',?2,w.balance_cents,w.reserved_cents,'topup_order',CAST(?3 AS TEXT),?4,?5,?6 FROM wallets w WHERE w.company_id=?1`
    ).bind(companyId, amountCents, topupOrderId, `topup:${topupOrderId}`, note, now),
    db
      .prepare(`UPDATE topup_orders SET credited_tx_id = (SELECT id FROM wallet_transactions WHERE company_id = ?1 AND idempotency_key = ?2) WHERE id = ?3`)
      .bind(companyId, `topup:${topupOrderId}`, topupOrderId),
  ]);
  return true;
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
