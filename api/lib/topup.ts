// ============================================================================
// Recargas de crédito — ciclo de vida do topup_order + confirmação SECURA.
// Crédito só entra via confirmTopupFromProvider(), que SEMPRE re-consulta o
// gateway (fonte da verdade) — webhook é só um "aviso" para ir consultar.
// ============================================================================
import type { Env } from "../types";
import { nowIso, err, json } from "./utils";
import { pickPaymentProvider, topupCode } from "./payments";
import { creditTopup, ensureWallet } from "./wallet";
import { audit } from "./audit";
import type { SessionUser } from "../types";

export interface TopupRow {
  id: number;
  company_id: number;
  code: string;
  amount_cents: number;
  status: string;
  provider: string;
  provider_payment_id: string | null;
  qr_code_text: string;
  qr_code_base64: string;
  expires_at: string | null;
  paid_at: string | null;
  credited_at?: string | null;
  created_at: string;
}

export async function createTopup(env: Env, companyId: number, amountCents: number, payerEmail: string, user: SessionUser | null) {
  const db = env.DB;
  const limits = await db.prepare(`SELECT key, value FROM platform_settings WHERE key IN ('topup_min_cents','topup_max_cents')`).all<{ key: string; value: string }>();
  const l = Object.fromEntries(limits.results.map((r) => [r.key, Number(r.value)]));
  const min = l.topup_min_cents ?? 1000;
  const max = l.topup_max_cents ?? 500_000;
  if (!Number.isInteger(amountCents) || amountCents < min || amountCents > max) {
    return { ok: false as const, status: 422, message: `Valor fora dos limites (mín R$ ${(min / 100).toFixed(2)}, máx R$ ${(max / 100).toFixed(2)}).` };
  }
  const company = await db.prepare(`SELECT demo, name FROM companies WHERE id = ?1`).bind(companyId).first<{ demo: number; name: string }>();
  const { provider, error } = pickPaymentProvider(env, company?.demo === 1);
  if (!provider) return { ok: false as const, status: 503, message: error ?? "Gateway indisponível" };

  const code = topupCode();
  const res = await provider.createPixPayment({ amountCents, externalReference: code, description: `Recarga de creditos WhatsApp - ${company?.name ?? "Tigu"}`, payerEmail });
  if (!res.ok) return { ok: false as const, status: 502, message: `Falha ao criar cobrança Pix: ${res.error}` };

  const ins = await db
    .prepare(
      `INSERT INTO topup_orders (company_id, code, amount_cents, status, provider, provider_payment_id, qr_code_text, qr_code_base64, expires_at, created_at, updated_at)
       VALUES (?1,?2,?3,'pending',?4,?5,?6,?7,?8,?9,?9)`
    )
    .bind(companyId, code, amountCents, provider.kind, res.providerPaymentId, res.qrCodeText, res.qrCodeBase64, res.expiresAt, nowIso())
    .run();
  const id = ins.meta.last_row_id as number;
  await audit(db, user, "topup.create", "topup_order", id, { code, amount_cents: amountCents, provider: provider.kind }, { companyId });
  const row = await db.prepare(`SELECT * FROM topup_orders WHERE id = ?1`).bind(id).first<TopupRow>();
  return { ok: true as const, topup: row!, mock: provider.kind === "mock" };
}

/**
 * Confirmação: re-consulta o provedor e credita (idempotente).
 * `externalId` = provider_payment_id OU code do pedido.
 */
export async function confirmTopupFromProvider(env: Env, externalId: string, via: "webhook" | "poll" | "mock" | "manual", justification = ""): Promise<{ ok: boolean; status?: string; credited: boolean; message?: string }> {
  const db = env.DB;
  const t = await db.prepare(`SELECT * FROM topup_orders WHERE provider_payment_id = ?1 OR code = ?1`).bind(externalId).first<TopupRow & { credited_at: string | null }>();
  if (!t) return { ok: false, credited: false, message: "Pedido de recarga não encontrado" };
  if (t.status === "paid") return { ok: true, status: "paid", credited: false }; // já creditada (idempotente)

  let providerStatus = "approved";
  if (via !== "manual" && via !== "mock") {
    const company = await db.prepare(`SELECT demo FROM companies WHERE id = ?1`).bind(t.company_id).first<{ demo: number }>();
    const { provider } = pickPaymentProvider(env, company?.demo === 1);
    if (!provider) return { ok: false, credited: false, message: "Gateway indisponível para re-consulta" };
    const st = await provider.getPaymentStatus(t.provider_payment_id || "");
    providerStatus = st.status;
    if (providerStatus !== "approved") {
      // pendente/expirado/recusado — NÃO credita
      if (["cancelled", "rejected", "expired"].includes(providerStatus)) {
        await db.prepare(`UPDATE topup_orders SET status='expired', updated_at=?2 WHERE id=?1`).bind(t.id, nowIso()).run();
      }
      return { ok: true, status: providerStatus, credited: false };
    }
    // Pagamento aprovado não basta: confira que a ordem pertence ao Tigu,
    // foi paga em reais, via Pix, e pelo valor EXATO do pedido.
    if (t.provider === "mercadopago") {
      const detail = st.detail || {};
      const externalReference = String(detail.external_reference ?? "");
      const currency = String(detail.currency_id ?? "");
      const method = String(detail.payment_method_id ?? "");
      const amountPaid = Number(detail.transaction_amount);
      const amountPaidCents = Number.isFinite(amountPaid) ? Math.round(amountPaid * 100) : NaN;
      if (externalReference !== t.code || currency !== "BRL" || method !== "pix" ||
          amountPaidCents !== t.amount_cents || String(detail.id ?? "") !== String(t.provider_payment_id ?? "")) {
        return { ok: false, status: "mismatch", credited: false,
          message: "Dados do pagamento não correspondem ao pedido (valor, referência, método ou moeda)." };
      }
    }
  }
  const credited = await creditTopup(db, t.company_id, t.amount_cents, t.id, via === "manual" ? `Confirmação manual pelo Tigu: ${justification}` : via === "mock" ? "Confirmação simulada (ambiente de demonstração)" : "Pix aprovado (re-consultado no gateway)");
  if (credited) {
    await ensureWallet(db, t.company_id);
    await audit(db, null, `topup.confirm.${via}`, "topup_order", t.id, { code: t.code, amount_cents: t.amount_cents, justification }, { companyId: t.company_id, scope: via === "manual" ? "platform" : "company" });
    await db
      .prepare(`INSERT INTO notifications (company_id, audience, title, body, kind) VALUES (?1,'admin','Recarga confirmada','Créditos de R$ ' || printf('%.2f', ?2/100.0) || ' adicionados à carteira via Pix.','billing')`)
      .bind(t.company_id, t.amount_cents)
      .run();
  }
  return { ok: true, status: "paid", credited };
}

/** Expira pendências vencidas (chamado pelo cron) — nunca afeta pagas. */
export async function expirePendingTopups(env: Env, companyId?: number): Promise<number> {
  const db = env.DB;
  const scope = companyId ? " AND company_id = ?2" : "";
  const res = await db
    .prepare(`UPDATE topup_orders SET status='expired', updated_at=?1 WHERE status='pending' AND expires_at IS NOT NULL AND expires_at < strftime('%Y-%m-%dT%H:%M:%SZ','now')${scope}`)
    .bind(nowIso(), ...(companyId ? [companyId] : []))
    .run();
  return res.meta?.changes ?? 0;
}


/**
 * Recupera confirmações de Pix quando o webhook não foi recebido ou falhou.
 * Executar periodicamente pelo cron, em lotes pequenos; o gateway é consultado
 * antes de qualquer crédito e a carteira impede lançamentos duplicados.
 */
export async function reconcilePendingTopups(
  env: Env,
  limit = 20
): Promise<{ checked: number; credited: number; errors: number }> {
  const db = env.DB;
  const batchSize = Math.max(1, Math.min(50, Math.trunc(limit)));
  const { results } = await db.prepare(
    `SELECT provider_payment_id FROM topup_orders
     WHERE provider='mercadopago' AND status IN ('pending','expired')
       AND provider_payment_id IS NOT NULL AND provider_payment_id <> ''
       AND created_at >= strftime('%Y-%m-%dT%H:%M:%SZ','now','-48 hours')
     ORDER BY created_at DESC LIMIT ?1`
  ).bind(batchSize).all<{ provider_payment_id: string }>();
  const out = { checked: 0, credited: 0, errors: 0 };
  for (const row of results) {
    out.checked++;
    try {
      const res = await confirmTopupFromProvider(env, row.provider_payment_id, "poll");
      if (res.credited) out.credited++;
      else if (!res.ok) out.errors++;
    } catch (e) {
      out.errors++;
      console.error("[pix-reconcile]", String(e).slice(0, 200));
    }
  }
  return out;
}
