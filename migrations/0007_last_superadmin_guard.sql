-- Evita perda total do acesso administrativo, inclusive em operações concorrentes.
-- Não altera contas existentes. A regra vale para UPDATE/DELETE de qualquer origem.
CREATE TRIGGER IF NOT EXISTS users_keep_last_superadmin_update
BEFORE UPDATE OF active, platform_role ON users
WHEN OLD.active=1 AND OLD.platform_role='superadmin'
  AND (NEW.active<>1 OR NEW.platform_role<>'superadmin')
  AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND active=1 AND platform_role='superadmin')
BEGIN
  SELECT RAISE(ABORT,'TIGU_LAST_SUPERADMIN');
END;

CREATE TRIGGER IF NOT EXISTS users_keep_last_superadmin_delete
BEFORE DELETE ON users
WHEN OLD.active=1 AND OLD.platform_role='superadmin'
  AND NOT EXISTS(SELECT 1 FROM users WHERE id<>OLD.id AND active=1 AND platform_role='superadmin')
BEGIN
  SELECT RAISE(ABORT,'TIGU_LAST_SUPERADMIN');
END;
