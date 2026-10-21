-- Credenciais por empresa: nunca compartilhar o token financeiro da plataforma.
CREATE TABLE company_payment_integrations (
 company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
 account_id TEXT NOT NULL,
 access_token_enc TEXT NOT NULL,
 webhook_secret_enc TEXT NOT NULL,
 webhook_key TEXT NOT NULL UNIQUE,
 enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
-- Checkout de produtos independente das mensalidades, créditos e reservas.
ALTER TABLE orders ADD COLUMN customer_email TEXT;
ALTER TABLE orders ADD COLUMN checkout_key TEXT;
CREATE UNIQUE INDEX idx_orders_checkout_key ON orders(checkout_key) WHERE checkout_key IS NOT NULL;
ALTER TABLE orders ADD COLUMN payment_choice TEXT NOT NULL DEFAULT 'after_service'
 CHECK(payment_choice IN ('after_service','pix'));
CREATE TABLE order_payments (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
 order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
 code TEXT NOT NULL UNIQUE,
 lookup_token TEXT NOT NULL UNIQUE,
 amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
 status TEXT NOT NULL DEFAULT 'creating'
 CHECK(status IN ('creating','pending','paid','expired','failed','refund_required','refunded')),
 provider_payment_id TEXT,
 qr_code_text TEXT NOT NULL DEFAULT '',
 qr_code_base64 TEXT NOT NULL DEFAULT '',
 expires_at TEXT,
 paid_at TEXT,
 created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
 UNIQUE(company_id,provider_payment_id)
);
CREATE INDEX idx_order_payments_company_status ON order_payments(company_id,status,created_at);
CREATE TRIGGER order_payment_company_guard BEFORE INSERT ON order_payments
 WHEN NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND company_id=NEW.company_id)
BEGIN SELECT RAISE(ABORT,'order tenant mismatch'); END;
CREATE TRIGGER booking_payment_company_guard_update BEFORE UPDATE OF company_id,booking_id ON booking_payments
 WHEN NOT EXISTS(SELECT 1 FROM bookings WHERE id=NEW.booking_id AND company_id=NEW.company_id)
BEGIN SELECT RAISE(ABORT,'booking tenant mismatch'); END;
CREATE TRIGGER order_payment_company_guard_update BEFORE UPDATE OF company_id,order_id ON order_payments
 WHEN NOT EXISTS(SELECT 1 FROM orders WHERE id=NEW.order_id AND company_id=NEW.company_id)
BEGIN SELECT RAISE(ABORT,'order tenant mismatch'); END;
CREATE TRIGGER order_payment_cancel_refund AFTER UPDATE OF status ON orders
 WHEN NEW.status='cancelado' AND OLD.status<>'cancelado'
BEGIN
 UPDATE order_payments SET status='refund_required',updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 WHERE order_id=NEW.id AND company_id=NEW.company_id AND status='paid';
END;
