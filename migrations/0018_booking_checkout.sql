-- Pagamento opcional de serviços: não modifica agendamentos existentes.
ALTER TABLE bookings ADD COLUMN payment_choice TEXT NOT NULL DEFAULT 'after_service'
  CHECK(payment_choice IN ('after_service','pix'));
CREATE TABLE booking_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  booking_id INTEGER NOT NULL UNIQUE REFERENCES bookings(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE,
  amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK(status IN ('creating','pending','paid','expired','failed','refund_required','refunded')),
  provider_payment_id TEXT UNIQUE,
  qr_code_text TEXT NOT NULL DEFAULT '',
  qr_code_base64 TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  paid_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now'))
);
CREATE INDEX idx_booking_payments_company_status ON booking_payments(company_id,status,created_at);
CREATE TRIGGER booking_payment_cancel_refund AFTER UPDATE OF status ON bookings
WHEN NEW.status='cancelado' AND OLD.status<>'cancelado'
BEGIN
 UPDATE booking_payments SET status='refund_required',updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 WHERE booking_id=NEW.id AND company_id=NEW.company_id AND status='paid';
END;
