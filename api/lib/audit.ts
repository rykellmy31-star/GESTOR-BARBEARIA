// Auditoria com escopo: empresa (painel) ou plataforma (super). Nunca bloqueia a operação.
import type { SessionUser } from "../types";

export async function audit(
  db: D1Database,
  user: SessionUser | null | undefined,
  action: string,
  entity: string,
  entityId: number | string = "",
  meta: unknown = {},
  opts: { companyId?: number | null; scope?: "company" | "platform" } = {}
): Promise<void> {
  try {
    const companyId = opts.companyId ?? user?.company?.id ?? null;
    const scope = opts.scope ?? (companyId ? "company" : "platform");
    await db
      .prepare(`INSERT INTO audit_log (company_id, scope, user_id, user_name, action, entity, entity_id, meta) VALUES (?1,?2,?3,?4,?5,?6,?7,?8)`)
      .bind(companyId, scope, user?.id ?? null, user?.name ?? "sistema", action, entity, String(entityId), JSON.stringify(meta ?? {}))
      .run();
  } catch {
    /* noop por design */
  }
}
