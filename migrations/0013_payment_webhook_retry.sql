-- Reentrega segura de webhooks Pix já autenticados, sem recriar cobranças.
-- A última tentativa permite retomada após falha de Worker/D1 e impede
-- varreduras repetidas no mesmo evento enquanto o gateway está indisponível.
ALTER TABLE payment_webhook_events ADD COLUMN last_attempt_at TEXT;
ALTER TABLE payment_webhook_events ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_payment_webhook_retry
  ON payment_webhook_events (provider, processed, last_attempt_at, id);
