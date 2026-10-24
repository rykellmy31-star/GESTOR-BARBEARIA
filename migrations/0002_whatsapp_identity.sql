-- Tigu / 0002: cada identidade oficial da Meta pertence a uma única empresa.
-- O número identificador é vazio antes do onboarding; isso é permitido para
-- muitas empresas. Depois de conectado, a mesma phone_number_id não pode
-- ser atribuída a duas barbearias, evitando recebimento/troca de eventos.
-- Se o banco já contiver duplicatas, a migração falhará: investigar e corrigir
-- as conexões afetadas em vez de escolher arbitrariamente uma empresa.
CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_connections_phone_number_id
ON whatsapp_connections(phone_number_id)
WHERE phone_number_id <> '';
