-- Pix de serviços destinado exclusivamente ao profissional conectado via OAuth.
-- Registra identidade do beneficiário na cobrança para impedir troca de conta.
ALTER TABLE booking_payments ADD COLUMN receiver_barber_id INTEGER REFERENCES barbers(id);
ALTER TABLE booking_payments ADD COLUMN receiver_mp_user_id TEXT;
CREATE INDEX idx_booking_payments_receiver ON booking_payments(company_id,receiver_barber_id,status);

CREATE TRIGGER seller_payment_receiver_guard BEFORE INSERT ON booking_payments
WHEN NEW.receiver_barber_id IS NOT NULL AND (
 NEW.receiver_mp_user_id IS NULL OR NOT EXISTS (
  SELECT 1 FROM bookings b JOIN barbers br ON br.id=b.barber_id AND br.company_id=b.company_id
  JOIN seller_mp_accounts a ON a.company_id=b.company_id AND a.barber_id=b.barber_id
  WHERE b.id=NEW.booking_id AND b.company_id=NEW.company_id
   AND b.barber_id=NEW.receiver_barber_id AND a.mp_user_id=NEW.receiver_mp_user_id
 ))
BEGIN SELECT RAISE(ABORT,'seller recipient mismatch'); END;

-- Bloqueia troca ou remoção de recebedor com Pix ainda pendente de conciliação.
CREATE TRIGGER seller_payment_account_change_guard BEFORE UPDATE OF mp_user_id
ON seller_mp_accounts
WHEN OLD.mp_user_id<>NEW.mp_user_id AND EXISTS (
 SELECT 1 FROM booking_payments WHERE company_id=OLD.company_id
 AND receiver_barber_id=OLD.barber_id AND receiver_mp_user_id=OLD.mp_user_id
 AND status IN ('creating','pending','refund_required')
)
BEGIN SELECT RAISE(ABORT,'seller has unresolved payments'); END;

CREATE TRIGGER seller_payment_account_delete_guard BEFORE DELETE ON seller_mp_accounts
WHEN EXISTS (
 SELECT 1 FROM booking_payments WHERE company_id=OLD.company_id
 AND receiver_barber_id=OLD.barber_id AND receiver_mp_user_id=OLD.mp_user_id
 AND status IN ('creating','pending','refund_required')
)
BEGIN SELECT RAISE(ABORT,'seller has unresolved payments'); END;
