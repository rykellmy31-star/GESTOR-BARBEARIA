-- Revisão humana de conflitos de entrega/falha da Meta.
-- Histórico imutável: não movimenta créditos nem altera o estado dos envios.
CREATE TABLE IF NOT EXISTS message_conflict_reviews (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id        INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id            INTEGER NOT NULL REFERENCES message_jobs(id) ON DELETE CASCADE,
  revision          INTEGER NOT NULL CHECK(revision > 0),
  request_id        TEXT NOT NULL UNIQUE,
  decision          TEXT NOT NULL CHECK(decision IN ('provider_delivered','provider_failed','inconclusive')),
  evidence          TEXT NOT NULL CHECK(length(trim(evidence)) BETWEEN 20 AND 1000),
  reviewed_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  reviewed_by_name  TEXT NOT NULL,
  job_status        TEXT NOT NULL,
  provider_msg_id   TEXT NOT NULL,
  price_cents       INTEGER NOT NULL,
  reserved_cents    INTEGER NOT NULL,
  captured_at       TEXT,
  refunded_at       TEXT,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE(job_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_message_conflict_reviews_job
  ON message_conflict_reviews(company_id, job_id, revision DESC);
