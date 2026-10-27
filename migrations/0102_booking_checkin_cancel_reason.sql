-- Check-in presencial separado do status do agendamento.
-- Cancelamento mantém a justificativa estruturada sem sobrescrever observações do cliente.
ALTER TABLE bookings ADD COLUMN checked_in_at TEXT;
ALTER TABLE bookings ADD COLUMN checked_in_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE bookings ADD COLUMN checked_in_source TEXT CHECK(checked_in_source IN ('cliente','equipe'));
ALTER TABLE bookings ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_bookings_checked_in_company ON bookings(company_id,checked_in_at)
 WHERE checked_in_at IS NOT NULL;
