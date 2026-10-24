-- 0005: faturas de assinatura Tigu via Pix (separadas de recargas de WhatsApp).
-- Nenhuma credencial financeira fica no D1; cada invoice guarda valor e
-- plano congelados para conferência de status do Mercado Pago.
CREATE TABLE IF NOT EXISTS subscription_invoices (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 code TEXT NOT NULL UNIQUE,
 plan_code TEXT NOT NULL REFERENCES plans(code),
 amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
 status TEXT NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','pending','paid','expired','failed')),
 provider TEXT NOT NULL DEFAULT 'mercadopago' CHECK(provider='mercadopago'),
 provider_payment_id TEXT UNIQUE,
 qr_code_text TEXT NOT NULL DEFAULT '',
 qr_code_base64 TEXT NOT NULL DEFAULT '',
 expires_at TEXT,
 paid_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_subscription_invoices_company ON subscription_invoices(company_id,created_at DESC);
-- No máximo um Pix aberto por barbearia. Repetir clique não duplica cobranças.
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_invoices_open ON subscription_invoices(company_id)
  WHERE status IN ('creating','pending');

-- Assinaturas antigas ativas sem vencimento recebem uma janela de adaptação.
UPDATE subscriptions SET period_end=strftime('%Y-%m-%dT%H:%M:%SZ','now','+30 days'),
 updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 WHERE status='active' AND period_end IS NULL;
