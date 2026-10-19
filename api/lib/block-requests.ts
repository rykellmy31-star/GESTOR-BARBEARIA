import { localToUtc } from "./time";
import { slotKeysFor } from "./availability";
import { nowIso } from "./utils";

/** Aprovação serializada com a reserva dos slots; todos os aliases usam esta regra. */
export async function resolveBlockRequest(db:D1Database,companyId:number,requestId:number,approve:boolean,timezone:string) {
  const request=await db.prepare(`SELECT r.id,r.barber_id,r.date,r.start_min,r.end_min,r.status
    FROM block_requests r JOIN barbers b ON b.id=r.barber_id AND b.company_id=r.company_id
    WHERE r.id=?1 AND r.company_id=?2`).bind(requestId,companyId)
    .first<{id:number;barber_id:number;date:string;start_min:number;end_min:number;status:string}>();
  if(!request) return {ok:false as const,status:404,message:"Pedido não encontrado"};
  if(request.status!=="pendente") return {ok:false as const,status:409,message:"Pedido já resolvido"};
  const at=nowIso();
  if(!approve) {
    const result=await db.prepare("UPDATE block_requests SET status='recusado',resolved_at=?1 WHERE id=?2 AND company_id=?3 AND status='pendente'")
      .bind(at,requestId,companyId).run();
    return result.meta.changes===1 ? {ok:true as const} : {ok:false as const,status:409,message:"Pedido já resolvido"};
  }
  const start=localToUtc(timezone,request.date,request.start_min).toISOString().replace(/\.\d{3}Z$/,"Z");
  const end=localToUtc(timezone,request.date,request.end_min).toISOString().replace(/\.\d{3}Z$/,"Z");
  const code=`BLK-${crypto.randomUUID()}`;
  try {
    const results=await db.batch([
      db.prepare(`UPDATE block_requests SET status='aprovado',resolved_at=?1
        WHERE id=?2 AND company_id=?3 AND status='pendente' AND NOT EXISTS(
          SELECT 1 FROM bookings WHERE company_id=?3 AND barber_id=?4
          AND status IN('pendente','confirmado','no_show','bloqueio') AND starts_at<?6 AND ends_at>?5)`)
        .bind(at,requestId,companyId,request.barber_id,start,end),
      db.prepare(`INSERT INTO bookings(company_id,code,barber_id,starts_at,ends_at,price_cents,status,origin,customer_name,customer_phone,notes,cancel_token,created_at,updated_at)
        SELECT ?1,?2,?3,?4,?5,0,'bloqueio','barbeiro','Bloqueio aprovado','',?6,?7,?8,?8 WHERE changes()=1`)
        .bind(companyId,code,request.barber_id,start,end,`pedido #${requestId}`,crypto.randomUUID(),at),
      db.prepare(`INSERT INTO booking_slots(company_id,booking_id,barber_id,slot)
        SELECT ?1,b.id,?2,j.value FROM bookings b,json_each(?3) j
        WHERE b.company_id=?1 AND b.code=?4`)
        .bind(companyId,request.barber_id,JSON.stringify(slotKeysFor(start,end,5)),code),
    ]);
    if(results[0].meta.changes!==1) return {ok:false as const,status:409,message:"Pedido já resolvido ou horário ocupado. Remarque os clientes antes de aprovar."};
    return {ok:true as const};
  } catch(error) {
    if(String(error).includes("UNIQUE constraint failed: booking_slots"))
      return {ok:false as const,status:409,message:"Horário reservado por outra operação. Atualize a agenda."};
    throw error;
  }
}
