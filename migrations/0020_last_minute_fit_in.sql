-- Encaixe de última hora: preservar o plano original e o término real.
-- Nunca editar reservas antigas nem remover informações financeiras.
ALTER TABLE bookings ADD COLUMN scheduled_ends_at TEXT;
ALTER TABLE bookings ADD COLUMN actual_finished_at TEXT;
ALTER TABLE bookings ADD COLUMN fit_in_duration_min INTEGER
  CHECK (fit_in_duration_min IS NULL OR
    (fit_in_duration_min BETWEEN 5 AND 180 AND fit_in_duration_min % 5 = 0));
CREATE INDEX idx_bookings_fit_in_company ON bookings(company_id,starts_at)
  WHERE fit_in_duration_min IS NOT NULL;
