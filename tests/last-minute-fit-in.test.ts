/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll,describe,it,expect } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { applyBookingMigrations } from "./helpers/booking-migrations";
import { createBooking,finishBookingEarly,type BookingMutationCtx } from "../api/lib/booking";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc } from "../api/lib/time";
import type { Env } from "../api/types";

const db=env.DB as D1Database;
const timezone="America/Bahia";
beforeAll(async()=>{
 for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(x=>x.trim()).filter(Boolean))
  await db.prepare(sql).run();
 await applyBookingMigrations(db);
 // Proteção real de sobreposição usada em D1 produção/staging.
 const guard=await import("../migrations/0008_booking_overlap_guard.sql");
 for(const trigger of guard.default.match(/CREATE TRIGGER[\s\S]+?END;/g)??[])
  await db.prepare(trigger).run();
});
async function fixture(){
 const companyId=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Salão Encaixe')")
  .bind(crypto.randomUUID()).run()).meta.last_row_id);
 const barberId=Number((await db.prepare(
  "INSERT INTO barbers(company_id,slug,name,work_days,work_start,work_end,break_start,break_end) VALUES (?1,'profissional','Estilista','[0,1,2,3,4,5,6]','09:00','18:00','12:00','13:00')"
 ).bind(companyId).run()).meta.last_row_id);
 const serviceId=Number((await db.prepare(
  "INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',2999,30)"
 ).bind(companyId).run()).meta.last_row_id);
 await db.prepare("INSERT INTO service_barbers(service_id,barber_id) VALUES (?1,?2)")
  .bind(serviceId,barberId).run();
 const settings={...DEFAULT_SETTINGS,slot_step_min:30,min_lead_min:0,
  whatsapp_reminders_enabled:false,whatsapp_confirm_enabled:false,
  opening_hours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[String(d),{open:"09:00",close:"18:00"}]))};
 const ctx:BookingMutationCtx={db,companyId,settings,origin:"admin",
  env:{...env,APP_ENV:"development"} as Env};
 const future=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
 const iso=(mins:number)=>localToUtc(timezone,future,mins).toISOString().replace(/\.\d{3}Z$/,"Z");
 const book=(minute:number,fitInDurationMin?:number)=>createBooking(ctx,{
  serviceId,barberId,startsAt:iso(minute),name:"Cliente Fictício",
  phone:"557399999"+String(minute).padStart(4,"0"),
  consent:true,whatsappOptin:false,idempotencyKey:crypto.randomUUID(),
  ...(fitInDurationMin?{fitInDurationMin}:{})
 });
 return {ctx,companyId,barberId,serviceId,iso,book};
}
describe("Encaixe emergencial do salão",()=>{
 it("9h30-10h encerrado 9h45 libera 15min; cabe outro cliente antes das 10h",async()=>{
  const f=await fixture();
  const first=await f.book(570); // 09:30
  expect(first.ok).toBe(true);
  if(!first.ok)return;
  expect((await f.book(585,15)).ok).toBe(false); // 09:45 ainda ocupado
  const done=await finishBookingEarly(f.ctx,first.bookingId,new Date(f.iso(585)));
  expect(done).toMatchObject({ok:true,minutesAvailable:15,
    releasedFrom:f.iso(585),originalEnd:f.iso(600)});
  const row=await db.prepare(
   "SELECT starts_at,ends_at,scheduled_ends_at,actual_finished_at,status,price_cents FROM bookings WHERE id=?1"
  ).bind(first.bookingId).first<Record<string,unknown>>();
  expect(row).toMatchObject({starts_at:f.iso(570),ends_at:f.iso(585),
   scheduled_ends_at:f.iso(600),actual_finished_at:f.iso(585),
   status:"concluido",price_cents:2999});
  const locked=await db.prepare("SELECT count(*) AS n FROM booking_slots WHERE booking_id=?1")
   .bind(first.bookingId).first<{n:number}>();
  expect(locked?.n).toBe(0);
  const fit=await f.book(585,15);
  expect(fit.ok).toBe(true);
  if(fit.ok){
   expect(fit.endsAt).toBe(f.iso(600));
   const actual=await db.prepare("SELECT fit_in_duration_min,price_cents FROM bookings WHERE id=?1")
    .bind(fit.bookingId).first<{fit_in_duration_min:number;price_cents:number}>();
   expect(actual).toMatchObject({fit_in_duration_min:15,price_cents:2999});
  }
  expect((await f.book(600)).ok).toBe(true); // 10h, próximo cliente intacto
  expect((await f.book(585,20)).ok).toBe(false); // 09:45-10:05 se sobrepõe
 });
 it("somente o salão reduz duração; cliente não recebe exceção na grade pública",async()=>{
  const f=await fixture();
  const clientCtx={...f.ctx,origin:"cliente" as const};
  const res=await createBooking(clientCtx,{
   serviceId:f.serviceId,barberId:f.barberId,startsAt:f.iso(585),
   name:"Cliente Online",phone:"5573999888877",consent:true,
   whatsappOptin:false,idempotencyKey:crypto.randomUUID(),
   fitInDurationMin:15
  });
  expect(res).toMatchObject({ok:false,status:403});
  const bad=await f.book(585,40);
  expect(bad).toMatchObject({ok:false,status:422});
 });
 it("não permite encerrar serviço antes de iniciar ou depois do fim",async()=>{
  const f=await fixture(),first=await f.book(570);
  expect(first.ok).toBe(true);
  if(!first.ok)return;
  expect(await finishBookingEarly(f.ctx,first.bookingId,new Date(f.iso(565))))
   .toMatchObject({ok:false,status:409});
  expect(await finishBookingEarly(f.ctx,first.bookingId,new Date(f.iso(601))))
   .toMatchObject({ok:false,status:409});
  const stored=await db.prepare("SELECT status,ends_at FROM bookings WHERE id=?1")
   .bind(first.bookingId).first<{status:string;ends_at:string}>();
  expect(stored).toMatchObject({status:"pendente",ends_at:f.iso(600)});
 });
 it("reservas de outro tenant não podem ter horário liberado",async()=>{
  const f=await fixture(),other=await fixture();
  const first=await f.book(570);
  expect(first.ok).toBe(true);
  if(!first.ok)return;
  const bad=await finishBookingEarly(other.ctx,first.bookingId,new Date(f.iso(585)));
  expect(bad).toMatchObject({ok:false,status:404});
 });
 it("duas solicitações de encaixe concorrentes disputam um único horário",async()=>{
  const f=await fixture(),first=await f.book(570);
  expect(first.ok).toBe(true);
  if(!first.ok)return;
  expect((await finishBookingEarly(f.ctx,first.bookingId,new Date(f.iso(585)))).ok).toBe(true);
  const [a,b]=await Promise.all([f.book(585,15),f.book(585,15)]);
  expect([a,b].filter(x=>x.ok)).toHaveLength(1);
  expect([a,b].filter(x=>!x.ok)).toHaveLength(1);
 });
});
