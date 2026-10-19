-- Novas reservas e remarcações carregam o dia local usado na validação.
-- Registros existentes são preservados; confirmação/cancelamento não muda o dia.
ALTER TABLE bookings ADD COLUMN local_day TEXT;

CREATE TRIGGER IF NOT EXISTS bookings_open_day_insert
BEFORE INSERT ON bookings
WHEN NEW.local_day IS NOT NULL AND NEW.status IN ('pendente','confirmado','no_show','bloqueio')
  AND EXISTS(SELECT 1 FROM blocked_days d WHERE d.company_id=NEW.company_id
    AND (d.barber_id IS NULL OR d.barber_id=NEW.barber_id)
    AND d.date_from<=NEW.local_day AND d.date_to>=NEW.local_day)
BEGIN
  SELECT RAISE(ABORT,'TIGU_BOOKING_DAY_BLOCKED');
END;

CREATE TRIGGER IF NOT EXISTS bookings_open_day_update
BEFORE UPDATE OF starts_at,ends_at,barber_id,local_day ON bookings
WHEN NEW.local_day IS NOT NULL AND NEW.status IN ('pendente','confirmado','no_show','bloqueio')
  AND EXISTS(SELECT 1 FROM blocked_days d WHERE d.company_id=NEW.company_id
    AND (d.barber_id IS NULL OR d.barber_id=NEW.barber_id)
    AND d.date_from<=NEW.local_day AND d.date_to>=NEW.local_day)
BEGIN
  SELECT RAISE(ABORT,'TIGU_BOOKING_DAY_BLOCKED');
END;
