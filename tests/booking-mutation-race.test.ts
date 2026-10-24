import { applyBookingMigrations } from "./helpers/booking-migrations";
/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { createBooking,cancelBooking,rescheduleBooking,setBookingStatus,type BookingMutationCtx } from "../api/lib/booking";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc } from "../api/lib/time";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
beforeAll(async()=>{
  for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  await applyBookingMigrations(db);
});
// As duas operações leem o mesmo snapshot antes de poderem continuar.
function barrierDatabase():D1Database {
  let arrived=0;let release!:()=>void;
  const ready=new Promise<void>(resolve=>{release=resolve;});
  const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>({
    bind(...values:unknown[]){return wrap(stmt.bind(...values));},
    async first(column?:string){const row=column===undefined?await stmt.first():await stmt.first(column);if(++arrived===2)release();await ready;return row;},
  } as D1PreparedStatement);
  return {
    prepare(sql:string){const stmt=db.prepare(sql);return sql.includes("SELECT b.*")||sql.startsWith("SELECT * FROM bookings WHERE id")?wrap(stmt):stmt;},
    batch:(statements:D1PreparedStatement[])=>db.batch(statements),
  } as D1Database;
}
async function fixture(){
  const companyId=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Corridas de agenda')").bind(crypto.randomUUID()).run()).meta.last_row_id);
  const barberId=Number((await db.prepare("INSERT INTO barbers(company_id,slug,name,work_days,work_start,work_end) VALUES (?1,'barber','Barbeiro','[0,1,2,3,4,5,6]','09:05','18:00')").bind(companyId).run()).meta.last_row_id);
  const serviceId=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',1999,30)").bind(companyId).run()).meta.last_row_id);
  await db.prepare("INSERT INTO service_barbers(service_id,barber_id) VALUES (?1,?2)").bind(serviceId,barberId).run();
  const settings={...DEFAULT_SETTINGS,min_lead_min:0,whatsapp_reminders_enabled:false,whatsapp_confirm_enabled:false,opening_hours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[String(d),{open:"09:00",close:"18:00"}]))};
  const ctx:BookingMutationCtx={db,companyId,settings,origin:"admin",env:{...env,APP_ENV:"development"} as Env};
  const iso=(min:number)=>localToUtc("America/Bahia",day,min).toISOString().replace(/\.\d{3}Z$/,"Z");
  const created=await createBooking(ctx,{barberId,serviceId,startsAt:iso(545),name:"Cliente",phone:"5573999990000",consent:true,whatsappOptin:false,idempotencyKey:crypto.randomUUID()});
  if(!created.ok)throw Error(created.message);
  const id=created.bookingId;
  const row=()=>db.prepare("SELECT status,starts_at,ends_at,notes,schedule_version,mutation_token FROM bookings WHERE id=?1").bind(id).first<{status:string;starts_at:string;ends_at:string;notes:string;schedule_version:number;mutation_token:string}>();
  const slots=()=>db.prepare("SELECT slot FROM booking_slots WHERE booking_id=?1 ORDER BY slot").bind(id).all<{slot:string}>();
  const notifications=()=>db.prepare("SELECT count(*) n FROM notifications WHERE booking_id=?1").bind(id).first("n");
  return {ctx,id,companyId,iso,row,slots,notifications,racing:{...ctx,db:barrierDatabase()}};
}
describe("mutações concorrentes do mesmo agendamento",()=>{
  it("confirmação não restaura atendimento cancelado e operação perdedora não notifica",async()=>{
    const f=await fixture();
    const results=await Promise.all([cancelBooking(f.racing,f.id,{actorRole:"admin"}),setBookingStatus(f.racing,f.id,"confirmado")]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(results.find(r=>!r.ok)).toMatchObject({status:409});
    const saved=(await f.row())!;
    expect(["cancelado","confirmado"]).toContain(saved.status);
    expect((await f.slots()).results).toHaveLength(saved.status==="cancelado"?0:6);
    expect(await f.notifications()).toBe(2);
  });
  it("cancelamento e remarcação não apagam nem recriam slots da operação vencedora",async()=>{
    const f=await fixture();
    const results=await Promise.all([cancelBooking(f.racing,f.id,{actorRole:"admin"}),rescheduleBooking(f.racing,f.id,f.iso(605),"admin")]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(results.find(r=>!r.ok)).toMatchObject({status:409});
    const saved=(await f.row())!,slots=(await f.slots()).results;
    expect(saved.schedule_version).toBe(2);
    expect(slots).toHaveLength(saved.status==="cancelado"?0:6);
    if(saved.status!=="cancelado")expect(saved.starts_at).toBe(f.iso(605));
    expect(await f.notifications()).toBe(2);
  });
  it("duas remarcações baseadas no mesmo snapshot só consomem uma versão",async()=>{
    const f=await fixture();
    const results=await Promise.all([605,665].map(min=>rescheduleBooking(f.racing,f.id,f.iso(min),"admin")));
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    const saved=(await f.row())!;
    expect(saved.schedule_version).toBe(2);
    expect([f.iso(605),f.iso(665)]).toContain(saved.starts_at);
    expect((await f.slots()).results).toHaveLength(6);
    expect(await f.notifications()).toBe(2);
  });
  it("duplo cancelamento não repete motivo, versão ou aviso",async()=>{
    const f=await fixture();
    const results=await Promise.all([1,2].map(()=>cancelBooking(f.racing,f.id,{actorRole:"admin",reason:"Consulta médica"})));
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    const saved=(await f.row())!;
    expect(saved.cancel_reason).toBe("Consulta médica");
    expect(saved.notes).not.toContain("Consulta médica");
    expect(saved.schedule_version).toBe(2);
    expect(await f.notifications()).toBe(2);
  });
  it("duas mudanças de status não sobrescrevem a transição vencedora",async()=>{
    const f=await fixture();
    const results=await Promise.all([setBookingStatus(f.racing,f.id,"concluido"),setBookingStatus(f.racing,f.id,"confirmado")]);
    expect(results.filter(r=>r.ok)).toHaveLength(1);
    expect(results.find(r=>!r.ok)).toMatchObject({status:409});
    expect((await f.row())?.schedule_version).toBe(1);
    expect(await f.notifications()).toBe(2);
  });
  it("falha na notificação reverte versão, token e horários e permite nova tentativa",async()=>{
    const f=await fixture(),before=await f.row(),slots=await f.slots();
    const trigger=`fail_booking_notify_${crypto.randomUUID().replace(/-/g,"")}`;
    await db.prepare(`CREATE TRIGGER ${trigger} BEFORE INSERT ON notifications WHEN NEW.booking_id=${f.id} AND NEW.kind='reschedule' BEGIN SELECT RAISE(ABORT,'test notification rollback'); END`).run();
    try {await expect(rescheduleBooking(f.ctx,f.id,f.iso(605),"admin")).rejects.toThrow(/test notification rollback/);}
    finally {await db.prepare(`DROP TRIGGER ${trigger}`).run();}
    expect(await f.row()).toEqual(before);
    expect((await f.slots()).results).toEqual(slots.results);
    expect((await rescheduleBooking(f.ctx,f.id,f.iso(605),"admin")).ok).toBe(true);
  });
});
