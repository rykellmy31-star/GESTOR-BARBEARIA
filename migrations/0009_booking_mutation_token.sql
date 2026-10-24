-- Identifica a operação que venceu a atualização condicional de um atendimento.
-- Os efeitos no mesmo batch só se aplicam quando este token corresponde.
ALTER TABLE bookings ADD COLUMN mutation_token TEXT NOT NULL DEFAULT '';
