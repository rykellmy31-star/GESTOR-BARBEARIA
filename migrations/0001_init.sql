-- ============================================================================
-- TIGU — Migration 0001: plataforma SaaS multiempresa para barbearias
-- Cloudflare D1 / SQLite. Datas em UTC ISO-8601 ("...THH:MM:SSZ"); datas
-- locais "YYYY-MM-DD" no fuso da empresa. Valores monetários: CENTAVOS.
--
-- Multiempresa: TODA tabela operacional carrega company_id, com índices e
-- unicidades por empresa. O Worker nunca confia em identificador vindo do
-- cliente: a empresa é resolvida no servidor (slug na URL → empresas ativas;
-- painel via sessão + membership verificada).
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- Empresas (tenants) e planos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS companies (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  slug           TEXT NOT NULL UNIQUE,          -- /c/<slug>
  name           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended')),
  suspend_reason TEXT NOT NULL DEFAULT '',
  domain         TEXT UNIQUE,                     -- domínio próprio da barbearia (fase futura; só o registro aqui)
  plan_code      TEXT NOT NULL DEFAULT 'free',
  demo           INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)), -- empresa inteira fictícia (demo comercial)
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status, id);

CREATE TABLE IF NOT EXISTS plans (
  code            TEXT PRIMARY KEY,             -- free | pro | scale
  name            TEXT NOT NULL,
  price_cents_month INTEGER NOT NULL DEFAULT 0,
  max_barbers     INTEGER NOT NULL DEFAULT 3,   -- -1 = ilimitado
  max_messages_month INTEGER NOT NULL DEFAULT 500,
  whatsapp_enabled INTEGER NOT NULL DEFAULT 1 CHECK (whatsapp_enabled IN (0,1)),
  store_enabled   INTEGER NOT NULL DEFAULT 1 CHECK (store_enabled IN (0,1)),
  demo            INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  updated_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  plan_code  TEXT NOT NULL DEFAULT 'free',
  status     TEXT NOT NULL DEFAULT 'trial' CHECK (status IN ('trial','active','past_due','cancelled')),
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  period_end TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------------------------
-- Usuários GLOBAIS + vínculos por empresa (RBAC real, no backend)
-- role de plataforma: 'user' | 'superadmin'  (superadmin não gerencia empresas)
-- papel da empresa (membership): owner | manager | barber
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_role TEXT NOT NULL DEFAULT 'user' CHECK (platform_role IN ('user','superadmin')),
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,          -- minúsculo, normalizado
  password_hash TEXT NOT NULL,                 -- pbkdf2_sha256$iter$salt$hash
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  demo          INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  last_login_at TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS company_memberships (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('owner','manager','barber')),
  barber_id  INTEGER,                          -- quando role='barber'
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (company_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_memberships_user ON company_memberships(user_id, active);

-- Sessões (cookie HttpOnly → sha256 do token aqui)
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------------
-- Configurações: uma linha JSON por empresa + defaults de plataforma
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS company_settings (
  company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  data       TEXT NOT NULL,                    -- JSON validado por zod (api/lib/settings.ts)
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS platform_settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- ---------------------------------------------------------------------------
-- Catálogo operacional (tudo escopado por company_id)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS barbers (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug          TEXT NOT NULL,
  name          TEXT NOT NULL,
  specialty     TEXT NOT NULL DEFAULT '',
  bio           TEXT NOT NULL DEFAULT '',
  photo         TEXT NOT NULL DEFAULT '',
  work_days     TEXT NOT NULL DEFAULT '[1,2,3,4,5,6]',
  work_start    TEXT NOT NULL DEFAULT '09:00',
  work_end      TEXT NOT NULL DEFAULT '20:00',
  break_start   TEXT NOT NULL DEFAULT '12:00',
  break_end     TEXT NOT NULL DEFAULT '13:00',
  rating        REAL NOT NULL DEFAULT 5.0,
  reviews_count INTEGER NOT NULL DEFAULT 0,
  active        INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  sort          INTEGER NOT NULL DEFAULT 0,
  demo          INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (company_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_barbers_company ON barbers(company_id, active, sort);

CREATE TABLE IF NOT EXISTS services (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug            TEXT NOT NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
  duration_min    INTEGER NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  category        TEXT NOT NULL DEFAULT 'cabelo',
  photo           TEXT NOT NULL DEFAULT '',
  active          INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  show_in_catalog INTEGER NOT NULL DEFAULT 1 CHECK (show_in_catalog IN (0,1)),
  sort            INTEGER NOT NULL DEFAULT 0,
  demo            INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (company_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_services_company ON services(company_id, active, show_in_catalog, sort);

CREATE TABLE IF NOT EXISTS service_barbers (
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  barber_id  INTEGER NOT NULL REFERENCES barbers(id)  ON DELETE CASCADE,
  PRIMARY KEY (service_id, barber_id)
);
CREATE INDEX IF NOT EXISTS idx_service_barbers_barber ON service_barbers(barber_id);

CREATE TABLE IF NOT EXISTS customers (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  phone           TEXT NOT NULL,                -- dígitos normalizados
  email           TEXT,
  notes           TEXT NOT NULL DEFAULT '',
  whatsapp_optin  INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_optin IN (0,1)), -- consentimento p/ mensagens
  lgpd_consent_at TEXT,
  anonymized_at   TEXT,                          -- LGPD: dados descaracterizados
  demo            INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (company_id, phone)
);
CREATE INDEX IF NOT EXISTS idx_customers_company_phone ON customers(company_id, phone);

-- ---------------------------------------------------------------------------
-- Agendamentos — a mesma trava do Aurum (slots com UNIQUE por barbeiro;
-- barbeiros pertencem a UMA empresa ⇒ isolamento físico garantido)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS bookings (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id     INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code           TEXT NOT NULL UNIQUE,           -- protocolo global-único (busca usa empresa+telefone)
  customer_id    INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  barber_id      INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  service_id     INTEGER REFERENCES services(id) ON DELETE RESTRICT, -- NULL só em bloqueios
  starts_at      TEXT NOT NULL,
  ends_at        TEXT NOT NULL,
  price_cents    INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pendente'
                 CHECK (status IN ('pendente','confirmado','concluido','cancelado','no_show','bloqueio')),
  origin         TEXT NOT NULL DEFAULT 'cliente'
                 CHECK (origin IN ('cliente','admin','barbeiro')),
  customer_name  TEXT NOT NULL,
  customer_phone TEXT NOT NULL,
  customer_email TEXT,
  notes          TEXT NOT NULL DEFAULT '',
  whatsapp_optin INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_optin IN (0,1)),
  schedule_version INTEGER NOT NULL DEFAULT 1,   -- muda a cada remarcação; invalida lembretes antigos
  cancel_token   TEXT NOT NULL,
  allowed_cancel_until TEXT,
  idempotency_key TEXT UNIQUE,
  demo           INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (service_id IS NOT NULL OR status = 'bloqueio')
);
CREATE INDEX IF NOT EXISTS idx_bookings_company_time ON bookings(company_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_barber_time ON bookings(barber_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(company_id, status, starts_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(company_id, customer_phone);

CREATE TABLE IF NOT EXISTS booking_slots (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  booking_id INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  barber_id  INTEGER NOT NULL REFERENCES barbers(id)  ON DELETE CASCADE,
  slot       TEXT NOT NULL,                      -- "YYYY-MM-DD HH:MM" UTC
  UNIQUE (barber_id, slot)
);
CREATE INDEX IF NOT EXISTS idx_booking_slots_booking ON booking_slots(booking_id);

CREATE TABLE IF NOT EXISTS blocked_days (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  barber_id  INTEGER REFERENCES barbers(id) ON DELETE CASCADE,
  date_from  TEXT NOT NULL,
  date_to    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'day_off' CHECK (kind IN ('day_off','vacation','holiday','other')),
  reason     TEXT NOT NULL DEFAULT '',
  demo       INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_blocked_days ON blocked_days(company_id, barber_id, date_from, date_to);

CREATE TABLE IF NOT EXISTS block_requests (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  barber_id   INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  date        TEXT NOT NULL,
  start_min   INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1439),
  end_min     INTEGER NOT NULL CHECK (end_min BETWEEN 1 AND 1440),
  reason      TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','aprovado','recusado')),
  demo        INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  resolved_at TEXT,
  CHECK (end_min > start_min)
);
CREATE INDEX IF NOT EXISTS idx_block_requests ON block_requests(company_id, status, date);

CREATE TABLE IF NOT EXISTS reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id    INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  barber_id     INTEGER NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  booking_id    INTEGER UNIQUE REFERENCES bookings(id) ON DELETE SET NULL,
  customer_name TEXT NOT NULL,
  rating        INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment       TEXT NOT NULL DEFAULT '',
  demo          INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_reviews_company ON reviews(company_id, created_at);

-- ---------------------------------------------------------------------------
-- Loja de produtos + pedidos
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  stock       INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  category    TEXT NOT NULL DEFAULT 'cuidados',
  photo       TEXT NOT NULL DEFAULT '',
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  featured    INTEGER NOT NULL DEFAULT 0 CHECK (featured IN (0,1)),
  demo        INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (company_id, slug)
);
CREATE INDEX IF NOT EXISTS idx_products_company ON products(company_id, active, category);

CREATE TABLE IF NOT EXISTS orders (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code             TEXT NOT NULL UNIQUE,
  customer_name    TEXT NOT NULL,
  customer_phone   TEXT NOT NULL,
  channel          TEXT NOT NULL DEFAULT 'whatsapp' CHECK (channel IN ('whatsapp','balcao','online')),
  status           TEXT NOT NULL DEFAULT 'novo' CHECK (status IN ('novo','pago','entregue','cancelado')),
  total_cents      INTEGER NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
  payment_provider TEXT NOT NULL DEFAULT 'none',
  demo             INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_orders_company ON orders(company_id, status, created_at);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name     TEXT NOT NULL,
  qty              INTEGER NOT NULL CHECK (qty > 0),
  unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents >= 0)
);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);

CREATE TABLE IF NOT EXISTS stock_movements (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  delta      INTEGER NOT NULL,
  reason     TEXT NOT NULL,
  ref        TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_stock_movements ON stock_movements(product_id, created_at);

-- ---------------------------------------------------------------------------
-- Notificações internas (sino) — por empresa
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  audience   TEXT NOT NULL CHECK (audience IN ('admin','barber')),
  user_id    INTEGER REFERENCES users(id) ON DELETE CASCADE,
  booking_id INTEGER REFERENCES bookings(id) ON DELETE SET NULL,
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  kind       TEXT NOT NULL DEFAULT 'booking'
             CHECK (kind IN ('booking','cancel','reschedule','block_request','order','system','message','billing','connection')),
  read_at    TEXT,
  demo       INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_box ON notifications(company_id, audience, user_id, read_at, created_at);

-- ============================================================================
-- WHATSAPP — conexões por empresa, fila persistente, tentativas, webhooks
-- ============================================================================

CREATE TABLE IF NOT EXISTS whatsapp_connections (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  provider         TEXT NOT NULL DEFAULT 'meta_cloud' CHECK (provider IN ('meta_cloud','mock')),
  status           TEXT NOT NULL DEFAULT 'disconnected'
                   CHECK (status IN ('disconnected','pending_setup','connected','error')),
  display_phone    TEXT NOT NULL DEFAULT '',        -- número comercial (exibição)
  waba_id          TEXT NOT NULL DEFAULT '',        -- WhatsApp Business Account id
  phone_number_id  TEXT NOT NULL DEFAULT '',        -- id Meta p/ envio
  business_name    TEXT NOT NULL DEFAULT '',
  access_token_enc TEXT NOT NULL DEFAULT '',        -- token longo cifrado (AES-256-GCM)
  coexistence      TEXT NOT NULL DEFAULT 'unknown'  -- app oficial + API
                   CHECK (coexistence IN ('unknown','enabled','not_eligible')),
  last_check_at    TEXT,
  last_error       TEXT NOT NULL DEFAULT '',
  connected_at     TEXT,
  demo             INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

-- Modelos de mensagem (espelho do que está aprovado na Meta; sincronizável)
CREATE TABLE IF NOT EXISTS whatsapp_templates (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id  INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code        TEXT NOT NULL,                 -- name no Meta
  language    TEXT NOT NULL DEFAULT 'pt_BR',
  category    TEXT NOT NULL DEFAULT 'utility' CHECK (category IN ('utility','marketing','authentication')),
  status      TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','approved','pending','rejected','disabled')),
  body_text   TEXT NOT NULL DEFAULT '',      -- espelho p/ conferência visual
  variables_n INTEGER NOT NULL DEFAULT 0,
  use_case    TEXT NOT NULL DEFAULT 'generic' -- reminder | confirmation | generic
              CHECK (use_case IN ('reminder','confirmation','generic')),
  active      INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  demo        INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (company_id, code, language)
);

-- Fila persistente de disparos (idempotente; sobrevive a restart do Worker)
CREATE TABLE IF NOT EXISTS message_jobs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id       INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL DEFAULT 'reminder'
                   CHECK (kind IN ('reminder','confirmation','manual','test')),
  booking_id       INTEGER REFERENCES bookings(id) ON DELETE CASCADE,
  to_phone         TEXT NOT NULL,
  template_code    TEXT NOT NULL,
  language         TEXT NOT NULL DEFAULT 'pt_BR',
  payload_json     TEXT NOT NULL DEFAULT '{}', -- snapshot p/ renderização (shop, quando, código…)
  scheduled_at     TEXT NOT NULL,              -- UTC; quando o cron pode disparar
  fire_deadline    TEXT NOT NULL,              -- depois disso, nunca mais envia (evita atrasado)
  status           TEXT NOT NULL DEFAULT 'scheduled'
                   CHECK (status IN ('scheduled','blocked_funds','sending','sent','delivered','read','failed','cancelled','skipped')),
  skip_reason      TEXT NOT NULL DEFAULT '',
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  next_attempt_at  TEXT,
  provider         TEXT NOT NULL DEFAULT 'meta_cloud',
  provider_msg_id  TEXT NOT NULL DEFAULT '',
  sent_at          TEXT,
  delivered_at     TEXT,
  read_at          TEXT,
  last_attempt_at  TEXT,
  price_cents      INTEGER NOT NULL DEFAULT 0,  -- snapshot da regra de cobrança no agendamento
  cost_cents       INTEGER NOT NULL DEFAULT 0,  -- custo estimado do fornecedor (snapshot)
  capture_on       TEXT NOT NULL DEFAULT 'sent' CHECK (capture_on IN ('sent','delivered')),
  reserved_cents   INTEGER NOT NULL DEFAULT 0,
  reservation_key  TEXT NOT NULL DEFAULT '',    -- idempotência p/ ledger
  captured_at      TEXT,
  refunded_at      TEXT,
  last_error       TEXT NOT NULL DEFAULT '',
  idempotency_key  TEXT NOT NULL,
  demo             INTEGER NOT NULL DEFAULT 0 CHECK (demo IN (0,1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  UNIQUE (company_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_jobs_due ON message_jobs(status, scheduled_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_jobs_booking ON message_jobs(booking_id, kind);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON message_jobs(company_id, created_at);

CREATE TABLE IF NOT EXISTS message_attempts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id       INTEGER NOT NULL REFERENCES message_jobs(id) ON DELETE CASCADE,
  n            INTEGER NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('accepted','retryable_error','permanent_error')),
  http_status  INTEGER,
  error        TEXT NOT NULL DEFAULT '',
  at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_attempts_job ON message_attempts(job_id, n);

-- Eventos de webhook já processados (dedupe + trilha de auditoria)
CREATE TABLE IF NOT EXISTS message_webhook_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
  job_id     INTEGER REFERENCES message_jobs(id) ON DELETE CASCADE,
  event_uid  TEXT NOT NULL UNIQUE,            -- provider + id/status/timestamp
  status     TEXT NOT NULL,                   -- sent | delivered | read | failed
  raw_json   TEXT NOT NULL DEFAULT '{}',
  processed  INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_events_job ON message_webhook_events(job_id, created_at);

-- ============================================================================
-- CARTEIRA DE CRÉDITOS + recargas (Pix) — livro-razão imutável
-- ============================================================================

CREATE TABLE IF NOT EXISTS wallets (
  company_id    INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  reserved_cents INTEGER NOT NULL DEFAULT 0,
  allow_negative INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative IN (0,1)), -- exceção EXPLÍCITA concedida pelo superadmin
  low_balance_alert_cents INTEGER NOT NULL DEFAULT 300,
  lifetime_charged_cents  INTEGER NOT NULL DEFAULT 0,  -- consumo reconhecido
  lifetime_recharged_cents INTEGER NOT NULL DEFAULT 0, -- recargas pagas
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  CHECK (allow_negative = 1 OR balance_cents >= 0),      -- TRAVA anti-saldo-negativo
  CHECK (allow_negative = 1 OR balance_cents >= reserved_cents), -- nunca reservar além do saldo
  CHECK (reserved_cents >= 0)
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id      INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  type            TEXT NOT NULL CHECK (type IN ('topup','reserve','capture','release','refund','adjust','chargeback')),
  amount_cents    INTEGER NOT NULL,             -- com sinal: entra positivo, sai negativo
  balance_after   INTEGER NOT NULL,             -- snapshot do saldo APÓS (auditoria)
  reserved_after  INTEGER NOT NULL DEFAULT 0,   -- snapshot do reservado APÓS
  ref_type        TEXT NOT NULL DEFAULT '',     -- message_job | topup_order | manual
  ref_id          TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT UNIQUE,                  -- ex.: capture:job-42 — nunca cobra 2x
  note            TEXT NOT NULL DEFAULT '',     -- justificativa (obrigatória p/ ajustes do super)
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_wtx_company ON wallet_transactions(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_wtx_ref ON wallet_transactions(ref_type, ref_id);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE, -- NULL = global (padrão da plataforma)
  category   TEXT NOT NULL DEFAULT 'any' CHECK (category IN ('any','utility','marketing','authentication')),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),          -- cobrado da barbearia
  cost_cents  INTEGER NOT NULL DEFAULT 0 CHECK (cost_cents >= 0),-- custo estimado do fornecedor
  active     INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pricing_lookup ON pricing_rules(company_id, category, active);

-- Pedidos de recarga (Pix) — crédito SÓ após confirmação via API do gateway
CREATE TABLE IF NOT EXISTS topup_orders (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id          INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  code                TEXT NOT NULL UNIQUE,      -- ex.: RGA-XXXXXXXX (também external_reference)
  amount_cents        INTEGER NOT NULL CHECK (amount_cents > 0),
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','paid','expired','cancelled','failed')),
  provider            TEXT NOT NULL DEFAULT 'mercadopago' CHECK (provider IN ('mercadopago','mock')),
  provider_payment_id TEXT UNIQUE,
  qr_code_text        TEXT NOT NULL DEFAULT '',
  qr_code_base64      TEXT NOT NULL DEFAULT '',
  expires_at          TEXT,
  paid_at             TEXT,
  credited_at         TEXT,                      -- quando o crédito entrou na carteira
  credited_tx_id      INTEGER REFERENCES wallet_transactions(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_topups_company ON topup_orders(company_id, created_at);

CREATE TABLE IF NOT EXISTS payment_webhook_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  provider   TEXT NOT NULL,
  event_uid  TEXT NOT NULL UNIQUE,
  payload    TEXT NOT NULL DEFAULT '{}',
  processed  INTEGER NOT NULL DEFAULT 0 CHECK (processed IN (0,1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,                     -- sha256 do código de 8 chars
  attempts   INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_pwresets_user ON password_resets(user_id, expires_at);

-- ============================================================================
-- Auditoria (empresa + plataforma). Nunca apagar; reter por política.
-- ============================================================================
CREATE TABLE IF NOT EXISTS audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER REFERENCES companies(id) ON DELETE SET NULL, -- NULL = ação de plataforma
  scope      TEXT NOT NULL DEFAULT 'company' CHECK (scope IN ('company','platform')),
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  user_name  TEXT NOT NULL DEFAULT '',
  action     TEXT NOT NULL,
  entity     TEXT NOT NULL,
  entity_id  TEXT NOT NULL DEFAULT '',
  meta       TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_log(company_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_scope ON audit_log(scope, created_at);

-- ---------------------------------------------------------------------------
-- Defaults de plataforma (todos ajustáveis pelo superadmin, sem deploy)
-- ---------------------------------------------------------------------------
INSERT OR IGNORE INTO platform_settings (key, value) VALUES
  ('msg_price_cents',        '10'),   -- R$ 0,10 por mensagem cobrável (preço inicial)
  ('msg_cost_cents',         '5'),    -- custo estimado do fornecedor (R$ 0,05)
  ('capture_on',             'sent'), -- 'sent' (aceita pelo provedor) | 'delivered'
  ('msg_max_attempts',       '3'),
  ('retry_backoff_sec',      '120'),  -- base do expoencial (2^n)
  ('topup_min_cents',        '1000'), -- R$ 10
  ('topup_max_cents',        '500000'),
  ('low_balance_alert_cents','300'),  -- alerta de saldo baixo (R$ 3,00)
  ('reminder_lead_min',      '60'),   -- lembrete 1h antes (editável por empresa)
  ('demo_flag',              '1');

INSERT OR IGNORE INTO plans (code, name, price_cents_month, max_barbers, max_messages_month, whatsapp_enabled, store_enabled) VALUES
  ('free', 'Tigu Start',  0,     2,  100, 0, 1),
  ('pro',  'Tigu Pro',    4990,  6,  3000, 1, 1),
  ('scale','Tigu Scale', 12990, -1, -1,   1, 1);
