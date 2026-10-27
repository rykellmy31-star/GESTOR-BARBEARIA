-- Complementa booking_slots: minutos de grades diferentes também podem se sobrepor.
-- Não altera dados existentes. Intervalos adjacentes permanecem permitidos.
CREATE TRIGGER IF NOT EXISTS bookings_no_overlap_insert
BEFORE INSERT ON bookings
WHEN NEW.status IN ('pendente','confirmado','no_show','bloqueio')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.barber_id=NEW.barber_id
      AND b.status IN ('pendente','confirmado','no_show','bloqueio')
      AND julianday(b.starts_at)<julianday(NEW.ends_at)
      AND julianday(b.ends_at)>julianday(NEW.starts_at)
  )
BEGIN
  SELECT RAISE(ABORT,'TIGU_BOOKING_OVERLAP');
END;

CREATE TRIGGER IF NOT EXISTS bookings_no_overlap_update
BEFORE UPDATE OF barber_id,starts_at,ends_at,status ON bookings
WHEN NEW.status IN ('pendente','confirmado','no_show','bloqueio')
  AND EXISTS (
    SELECT 1 FROM bookings b WHERE b.barber_id=NEW.barber_id AND b.id<>OLD.id
      AND b.status IN ('pendente','confirmado','no_show','bloqueio')
      AND julianday(b.starts_at)<julianday(NEW.ends_at)
      AND julianday(b.ends_at)>julianday(NEW.starts_at)
  )
BEGIN
  SELECT RAISE(ABORT,'TIGU_BOOKING_OVERLAP');
END;
