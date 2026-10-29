-- Evolution API v2: sessão por empresa, sem alterar a conexão Cloud API existente.
-- Uma única instalação pode hospedar várias instâncias independentes.
CREATE TABLE IF NOT EXISTS evolution_connections (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  instance_name TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending_setup' CHECK (status IN ('pending_setup','connected','error','disconnected')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  display_phone TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  connected_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_evolution_enabled ON evolution_connections(enabled, status);
