-- Autorização por vendedor: isolada dos pagamentos da plataforma TIGU.
-- Aplicar primeiro no D1 de homologação, antes de implantar endpoints OAuth.
CREATE TABLE IF NOT EXISTS seller_mp_oauth_pending (
 state_hash TEXT PRIMARY KEY,
 company_id INTEGER NOT NULL,
 barber_id INTEGER NOT NULL,
 user_id INTEGER NOT NULL,
 verifier_ciphertext TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 used_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 FOREIGN KEY(company_id) REFERENCES companies(id),
 FOREIGN KEY(barber_id) REFERENCES barbers(id),
 FOREIGN KEY(user_id) REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_seller_mp_oauth_pending_exp ON seller_mp_oauth_pending(expires_at);
CREATE TABLE IF NOT EXISTS seller_mp_accounts (
 company_id INTEGER NOT NULL,
 barber_id INTEGER NOT NULL,
 mp_user_id TEXT NOT NULL,
 access_ciphertext TEXT NOT NULL,
 refresh_ciphertext TEXT NOT NULL,
 expires_at TEXT NOT NULL,
 connected_by INTEGER NOT NULL,
 connected_at TEXT NOT NULL,
 updated_at TEXT NOT NULL,
 PRIMARY KEY(company_id,barber_id),
 FOREIGN KEY(company_id) REFERENCES companies(id),
 FOREIGN KEY(barber_id) REFERENCES barbers(id),
 FOREIGN KEY(connected_by) REFERENCES users(id)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_seller_mp_accounts_mp_account ON seller_mp_accounts(mp_user_id);
