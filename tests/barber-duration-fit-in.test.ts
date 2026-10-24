/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import initSql from "../migrations/0001_init.sql";
import { applyBookingMigrations } from "./helpers/booking-migrations";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc } from "../api/lib/time";
import { createBooking, finishBookingEarly, type BookingMutationCtx } from "../api/lib/booking";
import { computeDaySlots, effectiveServiceDuration, type BarberRow, type ServiceRow } from "../api/lib/availability";
import type { Env } from "../api/types";

const db=env.DB as D1Database;
beforeAll(async()=>{
 for(const stmt of initSql.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean))
  await db.prepare(stmt).run();
 await applyBookingMigrations(db);
});
const shop={...DEFAULT_SETTINGS,timezone:"America/Bahia" as const,slot_step_min:15,
 min_lead_min:0,opening_hours:Object.fromEntries([0,1,2,3,4,5,6].map(d=>[
  String(d),{open:"09:00",close:"18:00"}]))};
async function seed(){
 const name=crypto.randomUUID();
 const company=await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Duração teste')")
  .bind("duration-"+name).run();
 const companyId=Number(company.meta.last_row_id);
 const service=await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,?2,'Corte',3000,30)")
  .bind(companyId,"service-"+name).run();
 const serviceId=Number(service.meta.last_row_id);
 const ids:number[]=[];
 for(let i=0;i<2;i++){
  const row=await db.prepare("INSERT INTO barbers(company_id,slug,name,work_days,work_start,work_end,break_start,break_end) VALUES (?1,?2,?3,'[0,1,2,3,4,5,6]','09:00','18:00','12:00','13:00')")
   .bind(companyId,"barber-"+i+"-"+name,"Barbeiro "+i).run();
  const id=Number(row.meta.last_row_id);ids.push(id);
  await db.prepare("INSERT INTO service_barbers(service_id,barber_id) VALUES (?1,?2)")
   .bind(serviceId,id).run();
 }
 const day=new Date(Date.now()+5*86400000).toISOString().slice(0,10);
 const utc=(hour:number,min:number)=>localToUtc("America/Bahia",day,hour*60+min)
  .toISOString().replace(/\.\d{3}Z$/,"Z");
 const barber=async(id:number)=>(await db.prepare("SELECT * FROM barbers WHERE id=?1")
  .bind(id).first<BarberRow>())!;
 const srv=(await db.prepare("SELECT * FROM services WHERE id=?1").bind(serviceId).first<ServiceRow>())!;
 const context=(origin:"admin"|"barbeiro"|"cliente"):BookingMutationCtx=>({
  env:env as Env,db,companyId,origin,settings:shop
 });
 const booking=(barberId:number,startsAt:string,fitInDurationMin?:number)=>({
  barberId,serviceId,startsAt,name:"Cliente duração",phone:"5573999999999",consent:true,whatsappOptin:false,
  idempotencyKey:crypto.randomUUID(),fitInDurationMin
 });
 return {companyId,ids,serviceId,srv,barber,day,utc,context,booking};
}
describe("duração individual e encaixe sem superposição",()=>{
 it("ajusta 40 minutos de um barbeiro sem mudar colega nem o serviço",async()=>{
  const s=await seed();
  await db.prepare("UPDATE service_barbers SET duration_override_min=40 WHERE barber_id=?1 AND service_id=?2")
   .bind(s.ids[0],s.serviceId).run();
  expect(await effectiveServiceDuration(db,s.ids[0],s.srv)).toBe(40);
  expect(await effectiveServiceDuration(db,s.ids[1],s.srv)).toBe(30);
  expect(s.srv.duration_min).toBe(30);
  const first=await createBooking(s.context("barbeiro"),s.booking(s.ids[0],s.utc(9,10),40));
  expect(first.ok).toBe(true);
  if(!first.ok)throw Error(first.message);
  expect(first.endsAt).toBe(s.utc(9,50));
  const grid=await computeDaySlots(db,{barber:await s.barber(s.ids[0]),service:s.srv,
   day:s.day,settings:shop,mode:"public"});
  expect(grid.slots.some(x=>x.label==="09:50")).toBe(true);
  expect(grid.slots.some(x=>x.label==="09:45")).toBe(false);
  const clash=await createBooking(s.context("barbeiro"),s.booking(s.ids[0],s.utc(9,45),5));
  expect(clash.ok).toBe(false);
  const next=await createBooking(s.context("cliente"),s.booking(s.ids[0],s.utc(9,50)));
  expect(next.ok).toBe(true);
  const colleague=await createBooking(s.context("cliente"),s.booking(s.ids[1],s.utc(9,0)));
  expect(colleague.ok).toBe(true);
  if(colleague.ok)expect(colleague.endsAt).toBe(s.utc(9,30));
 });
 it("conclusão antecipada abre tempo livre para encaixe curto, mas não sobrepõe cliente existente",async()=>{
  const s=await seed();
  await db.prepare("UPDATE service_barbers SET duration_override_min=40 WHERE barber_id=?1 AND service_id=?2")
   .bind(s.ids[0],s.serviceId).run();
  const first=await createBooking(s.context("barbeiro"),s.booking(s.ids[0],s.utc(9,10),40));
  if(!first.ok)throw Error(first.message);
  const finish=await finishBookingEarly(s.context("barbeiro"),first.bookingId,
    new Date(s.utc(9,35)));
  expect(finish.ok).toBe(true);
  if(!finish.ok)throw Error(finish.message);
  expect(finish.releasedFrom).toBe(s.utc(9,35));
  const grid=await computeDaySlots(db,{barber:await s.barber(s.ids[0]),service:s.srv,
   day:s.day,settings:shop,mode:"public",now:new Date(s.utc(9,34))});
  // Um corte completo de 40 minutos não cabe em 15 minutos.
  expect(grid.slots.some(x=>x.label==="09:35")).toBe(false);
  const short=await createBooking(s.context("barbeiro"),s.booking(s.ids[0],s.utc(9,35),10));
  expect(short.ok).toBe(true);
  if(short.ok)expect(short.endsAt).toBe(s.utc(9,45));
  const collision=await createBooking(s.context("barbeiro"),s.booking(s.ids[0],s.utc(9,40),10));
  expect(collision.ok).toBe(false);
 });
});
