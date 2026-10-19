-- 0003: funil de interessados nos planos pagos (nenhuma cobrança ou ativação automática).
CREATE TABLE IF NOT EXISTS sales_leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  contact_name TEXT NOT NULL,
  company_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT NOT NULL,
  plan_code TEXT NOT NULL REFERENCES plans(code) CHECK(plan_code IN ('pro','scale')),
  price_snapshot_cents INTEGER NOT NULL CHECK(price_snapshot_cents >= 0),
  message TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','contacted','negotiating','closed')),
  internal_note TEXT NOT NULL DEFAULT '',
  consent_at TEXT NOT NULL,
  submission_bucket INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(email, plan_code, submission_bucket)
);
CREATE INDEX IF NOT EXISTS idx_sales_leads_status ON sales_leads(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_leads_created ON sales_leads(created_at DESC);

-- Tentativas por origem em janelas de uma hora, sem armazenar IPs em claro.
CREATE TABLE IF NOT EXISTS sales_lead_rate_limits (
  fingerprint TEXT NOT NULL,
  hour_bucket INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
  PRIMARY KEY (fingerprint, hour_bucket)
);
