import { applyBookingMigrations } from "./helpers/booking-migrations";
/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { computeDaySlots, assertSlotAllowed, isDayBlocked, monthSummary, type BarberRow } from "../api/lib/availability";
import { createBooking, rescheduleBooking } from "../api/lib/booking";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc } from "../api/lib/time";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
beforeAll(async()=>{
  for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
  await applyBookingMigrations(db);
});
const settings={...DEFAULT_SETTINGS,slot_step_min:15,opening_hours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[String(d),{open:"09:00",close:"18:00"}]))};
const day=new Date(Date.now()+3*86400000).toISOString().slice(0,10);
async function fixture(){
  const company=await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Agenda isolada')").bind(`agenda-${crypto.randomUUID()}`).run();
  const companyId=Number(company.meta.last_row_id);
  const inserted=await db.prepare("INSERT INTO barbers(company_id,slug,name,work_days,work_start,work_end,break_start,break_end) VALUES (?1,'barber','Barber','[0,1,2,3,4,5,6]','09:05','18:00','12:00','13:00')").bind(companyId).run();
  const barber=await db.prepare("SELECT * FROM barbers WHERE id=?1").bind(inserted.meta.last_row_id).first<BarberRow>();
  const serviceId=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',1999,30)").bind(companyId).run()).meta.last_row_id);
  await db.prepare("INSERT INTO service_barbers(service_id,barber_id) VALUES (?1,?2)").bind(serviceId,barber!.id).run();
  return {companyId,barber:barber!,service:{id:serviceId,name:"Corte",price_cents:1999,duration_min:30}};
}
describe("agenda: isolamento e grade consistente",()=>{
  it("feriado geral fecha somente a empresa correspondente",async()=>{
    const a=await fixture(),b=await fixture();
    await db.prepare("INSERT INTO blocked_days(company_id,barber_id,date_from,date_to,kind,reason) VALUES (?1,NULL,?2,?2,'holiday','Feriado A')").bind(a.companyId,day).run();
    expect(await isDayBlocked(db,a.barber.id,day)).toMatchObject({blocked:true,kind:"holiday"});
    expect(await isDayBlocked(db,b.barber.id,day)).toEqual({blocked:false});
    expect((await computeDaySlots(db,{...a,day,settings,mode:"public"})).ok).toBe(false);
    const available=await computeDaySlots(db,{...b,day,settings,mode:"public"});
    expect(available.slots.length).toBeGreaterThan(0);
    const month=await monthSummary(db,{...b,month:day.slice(0,7),settings});
    expect(month.find(d=>d.day===day)?.status).not.toBe("day_off");
  });
  it("horário oferecido a partir de 09:05 é aceito e horário fora da grade é recusado",async()=>{
    const f=await fixture();
    const listed=await computeDaySlots(db,{...f,day,settings,mode:"public"});
    expect(listed.slots[0].label).toBe("09:05");
    expect((await assertSlotAllowed(db,{...f,startsAt:listed.slots[0].t,settings,origin:"cliente"})).ok).toBe(true);
    expect((await assertSlotAllowed(db,{...f,startsAt:localToUtc("America/Bahia",day,9*60+6).toISOString().replace(/\.\d{3}Z$/,"Z"),settings,origin:"cliente"})).ok).toBe(false);
  });
  it("remarcação pode sobrepor o horário anterior, mas nunca outra reserva",async()=>{
    const f=await fixture();
    const ctx={env:env as Env,db,companyId:f.companyId,settings,origin:"cliente" as const};
    const at=(m:number)=>localToUtc("America/Bahia",day,m).toISOString().replace(/\.\d{3}Z$/,"Z");
    const input={barberId:f.barber.id,serviceId:f.service.id,name:"Cliente",phone:"5573999990000",consent:true,whatsappOptin:false};
    const one=await createBooking(ctx,{...input,startsAt:at(9*60+5),idempotencyKey:crypto.randomUUID()});
    const two=await createBooking(ctx,{...input,startsAt:at(10*60+5),idempotencyKey:crypto.randomUUID()});
    expect(one.ok).toBe(true); expect(two.ok).toBe(true);
    if(!one.ok||!two.ok) throw new Error("Falha na preparação");
    expect((await rescheduleBooking(ctx,one.bookingId,at(9*60+20),"cliente")).ok).toBe(true);
    expect((await rescheduleBooking(ctx,one.bookingId,at(9*60+50),"cliente")).ok).toBe(false);
    expect(await db.prepare("SELECT starts_at FROM bookings WHERE id=?1").bind(one.bookingId).first("starts_at")).toBe(at(9*60+20));
  });
  it.each(["2026-02-30","2026-13-01","not-a-day"])("data inválida %s não gera exceção",async invalid=>{
    const f=await fixture();
    expect(await computeDaySlots(db,{...f,day:invalid,settings})).toMatchObject({ok:false,slots:[]});
    expect(await monthSummary(db,{...f,month:"2026-13",settings})).toEqual([]);
  });
});
