import { z } from "zod";
import { localToUtc } from "./time";
import { slotKeysFor } from "./availability";
import { nowIso } from "./utils";

export const calendarDaySchema = z.string().regex(/^[1-9]\d{3}-\d{2}-\d{2}$/).refine((day) => {
  const parsed = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day;
}, "Data inválida");
export const intervalBlockSchema = z.object({
  barberId: z.number().int().positive(),
  date: calendarDaySchema,
  startMin: z.number().int().min(0).max(1439),
  endMin: z.number().int().min(1).max(1440),
  reason: z.string().trim().max(200).default("Bloqueio da administração"),
}).refine((input) => input.endMin > input.startMin, { message: "Fim deve ser depois do início", path: ["endMin"] });

/** Fonte única para os bloqueios de intervalo do painel e do alias legado. */
export async function createAdminIntervalBlock(db:D1Database, companyId:number, timezone:string, input:z.infer<typeof intervalBlockSchema>) {
  const barber = await db.prepare("SELECT id FROM barbers WHERE id=?1 AND company_id=?2 AND active=1")
    .bind(input.barberId,companyId).first();
  if (!barber) return {ok:false as const,status:404,message:"Profissional inválido ou inativo para esta barbearia"};
  const start=localToUtc(timezone,input.date,input.startMin).toISOString().replace(/\.\d{3}Z$/,"Z");
  const end=localToUtc(timezone,input.date,input.endMin).toISOString().replace(/\.\d{3}Z$/,"Z");
  const code=`BLK-${crypto.randomUUID()}`, at=nowIso();
  try {
    const results=await db.batch([
      db.prepare(`INSERT INTO bookings(company_id,code,barber_id,service_id,starts_at,ends_at,price_cents,status,origin,customer_name,customer_phone,notes,cancel_token,created_at,updated_at)
        SELECT ?1,?2,b.id,NULL,?4,?5,0,'bloqueio','admin',?6,'',?6,?7,?8,?8 FROM barbers b
        WHERE b.id=?3 AND b.company_id=?1 AND b.active=1 AND NOT EXISTS(
          SELECT 1 FROM bookings WHERE company_id=?1 AND barber_id=b.id
          AND status IN('pendente','confirmado','no_show','bloqueio') AND starts_at<?5 AND ends_at>?4)`)
        .bind(companyId,code,input.barberId,start,end,input.reason,crypto.randomUUID(),at),
      db.prepare(`INSERT INTO booking_slots(company_id,booking_id,barber_id,slot)
        SELECT ?1,b.id,b.barber_id,j.value FROM bookings b,json_each(?2) j WHERE b.company_id=?1 AND b.code=?3`)
        .bind(companyId,JSON.stringify(slotKeysFor(start,end,5)),code),
    ]);
    if (results[0].meta.changes!==1) return {ok:false as const,status:409,message:"Horário ocupado ou profissional alterado. Atualize a agenda e remarque os clientes antes de bloquear."};
    return {ok:true as const,code};
  } catch (error) {
    if (String(error).includes("UNIQUE constraint failed: booking_slots"))
      return {ok:false as const,status:409,message:"Há agendamentos nesse horário. Atualize a agenda e remarque os clientes antes de bloquear."};
    throw error;
  }
}
