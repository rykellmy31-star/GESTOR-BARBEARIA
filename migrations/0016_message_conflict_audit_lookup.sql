-- Facilita verificar auditorias de revisoes financeiras sem varrer todo o
-- historico da empresa. Escopo parcial: somente eventos de conflito Meta.
-- Nao altera registros, saldos ou historico; seguro em bases existentes.
CREATE INDEX IF NOT EXISTS idx_audit_message_conflict_lookup
  ON audit_log(company_id, entity_id, user_id, user_name)
  WHERE scope='platform'
    AND action='message.conflict_review'
    AND entity='message_job';
