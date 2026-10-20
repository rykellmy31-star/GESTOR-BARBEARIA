-- Suporte a paginação da fila global do Super Admin (sem alterar dados).
-- O filtro de conflitos precisa usar EXATAMENTE a mesma expressão do endpoint.
-- Evita ler toda a fila quando um incidente antigo está além das primeiras páginas.
CREATE INDEX IF NOT EXISTS idx_message_jobs_meta_conflict_page
  ON message_jobs(id DESC)
  WHERE instr(COALESCE(last_error,''),'[CONFLITO META:')>0;

-- A busca combinada status+cursor usa a ordem id DESC sem ordenar a fila inteira.
CREATE INDEX IF NOT EXISTS idx_message_jobs_status_page
  ON message_jobs(status, id DESC);
