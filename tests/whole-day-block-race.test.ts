/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll,describe,expect,it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { applyBookingMigrations } from "./helpers/booking-migrations";
import { createBooking,rescheduleBooking,setBookingStatus,type BookingMutationCtx } from "../api/lib/booking";
import { createAdminDayBlock,createAdminIntervalBlock } from "../api/lib/admin-blocks";
import { resolveBlockRequest } from "../api/lib/block-requests";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc,addDays } from "../api/lib/time";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
beforeAll(async()=>{
  for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();
  await applyBookingMigrations(db);
});
function beforeBatch(action:()=>Promise<unknown>):D1Database {
  let fired=false;
  return {prepare:(sql:string)=>db.prepare(sql),async batch(statements:D1PreparedStatement[]){if(!fired){fired=true;await action();}return db.batch(statements);}} as D1Database;
}
async function fixture(){
  const companyId=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Folgas atômicas')").bind(crypto.randomUUID()).run()).meta.last_row_id);
  const barberId=Number((await db.prepare("INSERT INTO barbers(company_id,slug,name,work_days) VALUES (?1,'barber','Barbeiro','[0,1,2,3,4,5,6]')").bind(companyId).run()).meta.last_row_id);
  const serviceId=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',1999,30)").bind(companyId).run()).meta.last_row_id);
  await db.prepare("INSERT INTO service_barbers(service_id,barber_id) VALUES (?1,?2)").bind(serviceId,barberId).run();
  const settings={...DEFAULT_SETTINGS,min_lead_min:0,whatsapp_reminders_enabled:false,whatsapp_confirm_enabled:false,opening_hours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[String(d),{open:"09:00",close:"18:00"}]))};
  const ctx:BookingMutationCtx={db,companyId,settings,origin:"cliente",env:{...env,APP_ENV:"development"} as Env};
  const iso=(date=day,min=540)=>localToUtc("America/Bahia",date,min).toISOString().replace(/\.\d{3}Z$/,"Z");
  const book=(database=db,date=day,min=540,bid=barberId)=>createBooking({...ctx,db:database},{barberId:bid,serviceId,startsAt:iso(date,min),name:"Cliente",phone:"5573999990000",consent:true,whatsappOptin:false,idempotencyKey:crypto.randomUUID()});
  const block=(bid:number|null=null,date=day)=>createAdminDayBlock(db,companyId,{barberId:bid,dateFrom:date,dateTo:date,kind:"holiday",reason:"Fechado"});
  const count=(table:"bookings"|"customers"|"booking_slots"|"notifications")=>db.prepare(`SELECT count(*) n FROM ${table} WHERE company_id=?1`).bind(companyId).first("n");
  return {companyId,barberId,serviceId,ctx,iso,book,block,count};
}
describe("folgas concorrentes com a reserva",()=>{
  it("fechar o dia após validar disponibilidade recusa a reserva e reverte cliente e avisos",async()=>{
    const f=await fixture();
    const result=await f.book(beforeBatch(()=>f.block()));
    expect(result).toMatchObject({ok:false,status:409});
    for(const table of ["bookings","customers","booking_slots","notifications"] as const)expect(await f.count(table)).toBe(0);
  });
  it("folga individual não bloqueia colega da mesma empresa nem outra barbearia",async()=>{
    const f=await fixture(),other=await fixture();
    await f.block(f.barberId);
    const colleague=Number((await db.prepare("INSERT INTO barbers(company_id,slug,name,work_days) VALUES (?1,'colega','Colega','[0,1,2,3,4,5,6]')").bind(f.companyId).run()).meta.last_row_id);
    await db.prepare("INSERT INTO service_barbers(service_id,barber_id) VALUES (?1,?2)").bind(f.serviceId,colleague).run();
    expect((await f.book()).ok).toBe(false);
    expect((await f.book(db,day,540,colleague)).ok).toBe(true);
    expect((await other.book()).ok).toBe(true);
  });
  it("remarcação perde a corrida para a folga e preserva reserva e slots originais",async()=>{
    const f=await fixture(),created=await f.book();
    if(!created.ok)throw Error(created.message);
    const target=addDays(day,1);
    const before=await db.prepare("SELECT starts_at,ends_at,schedule_version,mutation_token,local_day FROM bookings WHERE id=?1").bind(created.bookingId).first();
    const slots=(await db.prepare("SELECT slot FROM booking_slots WHERE booking_id=?1 ORDER BY slot").bind(created.bookingId).all()).results;
    const result=await rescheduleBooking({...f.ctx,db:beforeBatch(()=>f.block(null,target))},created.bookingId,f.iso(target),"admin");
    expect(result).toMatchObject({ok:false,status:409});
    expect(await db.prepare("SELECT starts_at,ends_at,schedule_version,mutation_token,local_day FROM bookings WHERE id=?1").bind(created.bookingId).first()).toEqual(before);
    expect((await db.prepare("SELECT slot FROM booking_slots WHERE booking_id=?1 ORDER BY slot").bind(created.bookingId).all()).results).toEqual(slots);
    expect(await f.count("notifications")).toBe(1);
  });
  it("fechar dia com atendimento existente preserva o atendimento e permite confirmá-lo",async()=>{
    const f=await fixture(),created=await f.book();if(!created.ok)throw Error(created.message);
    expect((await f.block()).ok).toBe(true);
    expect((await setBookingStatus(f.ctx,created.bookingId,"confirmado")).ok).toBe(true);
    expect((await f.book(db,day,600)).ok).toBe(false);
    expect(await f.count("bookings")).toBe(1);
  });
  it("pedido pendente não é aprovado depois de fechar o dia",async()=>{
    const f=await fixture();
    const id=Number((await db.prepare("INSERT INTO block_requests(company_id,barber_id,date,start_min,end_min,reason) VALUES (?1,?2,?3,600,660,'Consulta')").bind(f.companyId,f.barberId,day).run()).meta.last_row_id);
    await f.block();
    expect(await resolveBlockRequest(db,f.companyId,id,true,"America/Bahia")).toMatchObject({ok:false,status:409});
    expect(await db.prepare("SELECT status FROM block_requests WHERE id=?1").bind(id).first("status")).toBe("pendente");
    expect(await f.count("bookings")).toBe(0);
  });
  it("bloqueio de horário também respeita folga geral já gravada",async()=>{
    const f=await fixture();await f.block();
    expect(await createAdminIntervalBlock(db,f.companyId,"America/Bahia",{date:day,barberId:f.barberId,startMin:600,endMin:660,reason:"Bloqueio"})).toMatchObject({ok:false,status:409});
    expect(await f.count("bookings")).toBe(0);
    expect(await f.count("booking_slots")).toBe(0);
  });
});
