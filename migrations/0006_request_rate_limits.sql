-- Limites compartilhados entre instâncias/reinícios do Worker.
-- Apenas fingerprints com segredo; nenhum IP ou e-mail em claro.
CREATE TABLE IF NOT EXISTS request_rate_limits (
  fingerprint TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL CHECK(attempts > 0),
  reset_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_rate_limits_reset ON request_rate_limits(reset_at);
