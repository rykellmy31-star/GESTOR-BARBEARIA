import { isBookingConflictError } from "./booking-conflicts";
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
    if (isBookingConflictError(error))
      return {ok:false as const,status:409,message:"Há agendamentos nesse horário. Atualize a agenda e remarque os clientes antes de bloquear."};
    throw error;
  }
}

const dayBlockInputSchema=z.object({
  barberId:z.number().int().positive().nullable().optional(),
  barber_id:z.number().int().positive().nullable().optional(),
  dateFrom:calendarDaySchema.optional(),date_from:calendarDaySchema.optional(),date:calendarDaySchema.optional(),
  dateTo:calendarDaySchema.optional(),date_to:calendarDaySchema.optional(),
  kind:z.enum(["day_off","vacation","holiday","other"]).default("day_off"),
  reason:z.string().trim().max(200).default(""),
}).superRefine((data,ctx)=>{
  for (const keys of [["dateFrom","date_from","date"],["dateTo","date_to"],["barberId","barber_id"]] as const) {
    const supplied=keys.map(key=>data[key]).filter(value=>value!==undefined);
    if(new Set(supplied).size>1) ctx.addIssue({code:"custom",path:[keys[0]],message:"Campos equivalentes devem informar o mesmo valor"});
  }
});
export const dayBlockSchema=dayBlockInputSchema.transform(data=>{
  const from=data.dateFrom??data.date_from??data.date;
  return {barberId:data.barberId??data.barber_id??null,dateFrom:from,dateTo:data.dateTo??data.date_to??from,kind:data.kind,reason:data.reason};
}).pipe(z.object({barberId:z.number().int().positive().nullable(),dateFrom:calendarDaySchema,dateTo:calendarDaySchema,kind:z.enum(["day_off","vacation","holiday","other"]),reason:z.string()}))
  .refine(data=>data.dateTo>=data.dateFrom,{message:"A data final não pode ser anterior à inicial",path:["dateTo"]});

export async function createAdminDayBlock(db:D1Database,companyId:number,input:z.infer<typeof dayBlockSchema>) {
  if(input.barberId && !await db.prepare("SELECT id FROM barbers WHERE id=?1 AND company_id=?2").bind(input.barberId,companyId).first())
    return {ok:false as const,status:404,message:"Profissional inválido para esta barbearia"};
  const saved=await db.prepare(`INSERT INTO blocked_days(company_id,barber_id,date_from,date_to,kind,reason,created_at)
    SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE ?2 IS NULL OR EXISTS(SELECT 1 FROM barbers WHERE id=?2 AND company_id=?1)`)
    .bind(companyId,input.barberId,input.dateFrom,input.dateTo,input.kind,input.reason,nowIso()).run();
  if(saved.meta.changes!==1) return {ok:false as const,status:409,message:"O profissional foi alterado. Atualize a página antes de salvar."};
  return {ok:true as const,id:saved.meta.last_row_id};
}
