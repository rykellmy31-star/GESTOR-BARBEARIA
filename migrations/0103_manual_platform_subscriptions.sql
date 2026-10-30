-- Aditiva. Não altera faturas antigas, carteira WhatsApp, pagamentos de serviços ou assinaturas existentes.
CREATE TABLE IF NOT EXISTS subscription_plan_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  plan_code TEXT NOT NULL REFERENCES plans(code),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  handled_by INTEGER REFERENCES users(id),
  handled_at TEXT,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tigu_one_pending_plan_request
  ON subscription_plan_requests(company_id) WHERE status='pending';
CREATE INDEX IF NOT EXISTS idx_tigu_plan_requests_latest
  ON subscription_plan_requests(company_id,created_at DESC);

-- Registro de pagamentos feitos FORA do sistema. A confirmação é declarada pelo Super Admin;
-- nenhum valor é debitado, nenhum gateway é chamado e não há alteração automática de saldo.
CREATE TABLE IF NOT EXISTS manual_subscription_renewals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  plan_code TEXT NOT NULL REFERENCES plans(code),
  period_months INTEGER NOT NULL CHECK(period_months BETWEEN 1 AND 24),
  amount_cents INTEGER NOT NULL CHECK(amount_cents >= 0),
  external_reference TEXT NOT NULL,
  note TEXT NOT NULL,
  operator_user_id INTEGER NOT NULL REFERENCES users(id),
  applied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(company_id,external_reference)
);
CREATE INDEX IF NOT EXISTS idx_tigu_manual_renewals_latest
  ON manual_subscription_renewals(company_id,created_at DESC);
