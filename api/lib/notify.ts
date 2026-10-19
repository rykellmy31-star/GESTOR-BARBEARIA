// ============================================================================
// Notificações INTERNAS (sino) — por empresa e por usuário barbeiro.
// O envio WhatsApp vive em api/lib/messaging (fila message_jobs).
// ============================================================================
import { nowIso } from "./utils";
import { formatDateTimePtBr } from "./time";
import { brl } from "./utils";

export interface BookingNotifyPayload {
  code: string;
  customer_name: string;
  customer_phone: string;
  barber_id: number;
  barber_name: string;
  service_name: string;
  starts_at: string;
  price_cents: number;
  status: string;
}

const STATUS_LABEL: Record<string, string> = {
  pendente: "Pendente",
  confirmado: "Confirmado",
  concluido: "Concluído",
  cancelado: "Cancelado",
  no_show: "Não compareceu",
  bloqueio: "Bloqueio de agenda",
};

export function describeBooking(p: BookingNotifyPayload, tz: string): string {
  return `${p.customer_name} • ${p.service_name} com ${p.barber_name} • ${formatDateTimePtBr(tz, p.starts_at)} • ${brl(p.price_cents)} • ${STATUS_LABEL[p.status] ?? p.status}`;
}

/** INSERTs p/ sino do admin E do barbeiro — usados DENTRO do batch da mutação. */
export function insertBookingNotifications(
  db: D1Database,
  companyId: number,
  p: BookingNotifyPayload,
  tz: string,
  title: string,
  kind = "booking"
): D1PreparedStatement[] {
  // booking_id resolvido por subselect (código é único global) — funciona dentro
  // do mesmo batch da criação do agendamento, sem 2ª round-trip.
  const body = describeBooking(p, tz);
  return [
    db.prepare(
      `INSERT INTO notifications (company_id, audience, booking_id, title, body, kind, created_at)
       SELECT ?1,'admin', b.id, ?2, ?3, ?4, ?5 FROM bookings b WHERE b.code = ?6 AND b.company_id = ?1`
    ).bind(companyId, title, body, kind, nowIso(), p.code),
    db.prepare(
      `INSERT INTO notifications (company_id, audience, user_id, booking_id, title, body, kind, created_at)
       SELECT ?1,'barber', cm.user_id, b.id, ?2, ?3, ?4, ?5
       FROM company_memberships cm JOIN users u ON u.id = cm.user_id JOIN bookings b ON b.code = ?6 AND b.company_id = ?1
       WHERE cm.company_id = ?1 AND cm.barber_id = ?7 AND cm.role = 'barber' AND cm.active = 1 AND u.active = 1`
    ).bind(companyId, title, body, kind, nowIso(), p.code, p.barber_id),
  ];
}

export function notifyStmt(
  db: D1Database,
  companyId: number,
  row: { audience: "admin" | "barber"; user_id: number | null; title: string; body: string; kind: string }
): D1PreparedStatement {
  return db
    .prepare(`INSERT INTO notifications (company_id, audience, user_id, title, body, kind) VALUES (?1,?2,?3,?4,?5,?6)`)
    .bind(companyId, row.audience, row.user_id, row.title, row.body, row.kind);
}

export async function notifyGeneric(
  db: D1Database,
  companyId: number,
  rows: { audience: "admin" | "barber"; user_id: number | null; title: string; body: string; kind: string }[]
): Promise<void> {
  if (!rows.length) return;
  await db.batch(rows.map((r) => notifyStmt(db, companyId, r)));
}
