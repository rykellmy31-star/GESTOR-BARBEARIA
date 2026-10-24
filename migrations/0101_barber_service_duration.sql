-- Duração opcional de cada serviço por profissional; sem alterar serviços nem reservas existentes.
-- NULL continua usando a duração cadastrada pelo administrador da barbearia.
ALTER TABLE service_barbers
 ADD COLUMN duration_override_min INTEGER
 CHECK(duration_override_min IS NULL OR
       (duration_override_min BETWEEN 5 AND 480 AND duration_override_min % 5 = 0));
