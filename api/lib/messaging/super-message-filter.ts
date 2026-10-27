/** Filtros da fila global. "conflict" representa uma divergência operacional na Meta. */
export function parseGlobalMessageCursor(raw?: string): number | null | undefined {
  if (raw === undefined || raw === "") return null;
  if (!/^[1-9]\d*$/.test(raw)) return undefined;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function globalMessageListFilter(
  rawStatus?: string,
  beforeId: number | null = null,
): { where: string; binds: Array<string | number> } {
  const conditions: string[] = [];
  const binds: Array<string | number> = [];
  if (rawStatus === "conflict") {
    conditions.push("instr(COALESCE(j.last_error,''),'[CONFLITO META:')>0");
  } else if (rawStatus) {
    binds.push(rawStatus);
    conditions.push(`j.status = ?${binds.length}`);
  }
  if (beforeId !== null) {
    binds.push(beforeId);
    conditions.push(`j.id < ?${binds.length}`);
  }
  return { where: conditions.length ? `WHERE ${conditions.join(" AND ")}` : "", binds };
}

/** Optional tenant id: absent means global, invalid means deny, never fallback to global. */
export function parseOptionalMessageCompanyId(raw?: string): number | undefined | null {
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) ? id : null;
}
