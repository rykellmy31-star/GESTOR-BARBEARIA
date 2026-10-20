-- Mantem revisoes historicas auditaveis sem enfraquecer a checagem de snapshots novos.
-- 0 = evento legado, sem retrato financeiro; 1 = retrato financeiro v1.
ALTER TABLE message_conflict_reviews
  ADD COLUMN audit_snapshot_version INTEGER NOT NULL DEFAULT 0
  CHECK (audit_snapshot_version IN (0,1));

-- Registros criados antes desta migracao, mas ja auditados com snapshot v1,
-- nao podem ser rebaixados acidentalmente ao tratamento legado.
UPDATE message_conflict_reviews AS r
SET audit_snapshot_version=1
WHERE EXISTS (
  SELECT 1 FROM audit_log AS a
  WHERE a.company_id=r.company_id
    AND a.scope='platform'
    AND a.action='message.conflict_review'
    AND a.entity='message_job'
    AND a.entity_id=CAST(r.job_id AS TEXT)
    AND json_valid(a.meta)
    AND json_extract(a.meta,'$.request_id')=r.request_id
    AND json_extract(a.meta,'$.snapshot_version')=1
);
