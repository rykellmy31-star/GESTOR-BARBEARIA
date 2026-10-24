import { applyBookingMigrations } from "./helpers/booking-migrations";
/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { createBooking, cancelBooking, markBookingArrived, type BookingMutationCtx } from "../api/lib/booking";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc } from "../api/lib/time";
import { bookingPixEnabled } from "../api/lib/booking-payments";
import type { Env } from "../api/types";

const db = env.DB as D1Database;
beforeAll(async () => {
  for (const sql of schema.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean))
    await db.prepare(sql).run();
  await applyBookingMigrations(db);
});

async function company() {
  const slug = `idempotency-${crypto.randomUUID()}`;
  const c = await db.prepare("INSERT INTO companies (slug,name) VALUES (?1,'Isolamento')").bind(slug).run();
  const companyId = Number(c.meta.last_row_id);
  const b = await db.prepare("INSERT INTO barbers (company_id,slug,name,work_days,work_start,work_end) VALUES (?1,'barber','Barber','[0,1,2,3,4,5,6]','09:00','18:00')").bind(companyId).run();
  const s = await db.prepare("INSERT INTO services (company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',1999,30)").bind(companyId).run();
  const barberId = Number(b.meta.last_row_id), serviceId = Number(s.meta.last_row_id);
  await db.prepare("INSERT INTO service_barbers (service_id,barber_id) VALUES (?1,?2)").bind(serviceId,barberId).run();
  const ctx: BookingMutationCtx = {
    env: env as Env, db, companyId, origin: "cliente",
    settings: { ...DEFAULT_SETTINGS, opening_hours: Object.fromEntries([0,1,2,3,4,5,6].map(d => [String(d),{open:"09:00",close:"18:00"}])) },
  };
  return {ctx,barberId,serviceId};
}

describe("idempotência de agendamento entre empresas", () => {
  it("colisão global não retorna reserva nem token de outra barbearia", async () => {
    const a = await company(), b = await company();
    const day = new Date(Date.now()+3*86400000).toISOString().slice(0,10);
    const input = {
      startsAt: localToUtc("America/Bahia",day,10*60).toISOString().replace(/\.\d{3}Z$/,"Z"),
      name:"Cliente isolado",phone:"5573999990000",consent:true,whatsappOptin:false,
      idempotencyKey:crypto.randomUUID(),
    };
    const first = await createBooking(a.ctx,{...input,barberId:a.barberId,serviceId:a.serviceId});
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error(first.message);
    const collision = await createBooking(b.ctx,{...input,barberId:b.barberId,serviceId:b.serviceId});
    expect(collision).toMatchObject({ok:false,status:409});
    expect(JSON.stringify(collision)).not.toContain(first.cancelToken);
    expect(JSON.stringify(collision)).not.toContain(first.code);
    expect(collision).not.toHaveProperty("bookingId");
    expect(await db.prepare("SELECT count(*) AS n FROM bookings WHERE company_id=?1").bind(b.ctx.companyId).first("n")).toBe(0);
    expect(await db.prepare("SELECT count(*) AS n FROM customers WHERE company_id=?1").bind(b.ctx.companyId).first("n")).toBe(0);
    const repeat = await createBooking(a.ctx,{...input,barberId:a.barberId,serviceId:a.serviceId});
    expect(repeat).toMatchObject({ok:true,reused:true,bookingId:first.bookingId,cancelToken:first.cancelToken});
  });
});

describe("checkout do serviço", () => {
  it("o preço é registrado a partir do D1 e não do cliente", async () => {
    const a=await company();
    const day=new Date(Date.now()+5*86400000).toISOString().slice(0,10);
    const booking=await createBooking(a.ctx,{
      startsAt:localToUtc("America/Bahia",day,10*60).toISOString().replace(/\.\d{3}Z$/,"Z"),
      serviceId:a.serviceId,barberId:a.barberId,
      name:"Cliente Checkout Fictício",phone:"5573999991234",consent:true,whatsappOptin:false,
      idempotencyKey:crypto.randomUUID(),paymentChoice:"pix"
    });
    expect(booking.ok).toBe(true);
    if(!booking.ok)throw new Error(booking.message);
    const stored=await db.prepare("SELECT price_cents,payment_choice FROM bookings WHERE id=?1 AND company_id=?2")
      .bind(booking.bookingId,a.ctx.companyId).first<{price_cents:number;payment_choice:string}>();
    expect(stored).toMatchObject({price_cents:1999,payment_choice:"pix"});
  });
  it("a flag financeira é fechada por padrão e staging nunca permite cobrança", () => {
    const configured={APP_ENV:"production",MERCHANT_PIX_ENABLED:"1",MSG_ENC_KEY:"12345678901234567890123456789012",
      PUBLIC_URL:"https://tigu.example/", MP_MARKETPLACE_CLIENT_ID:"test-client",
      MP_MARKETPLACE_CLIENT_SECRET:"marketplace-client-test",
      MP_MARKETPLACE_WEBHOOK_SECRET:"marketplace-webhook-test-secret"} as Env;
    expect(bookingPixEnabled({...configured,MERCHANT_PIX_ENABLED:"0"})).toBe(false);
    expect(bookingPixEnabled({...configured,TIGU_STAGING:"1"})).toBe(false);
    expect(bookingPixEnabled({...configured,PAYMENTS_MOCK:"1"})).toBe(false);
    expect(bookingPixEnabled({...configured,MSG_ENC_KEY:undefined})).toBe(false);
    expect(bookingPixEnabled(configured)).toBe(true);
  });
});

describe("check-in presencial e motivo de cancelamento",()=>{
  it("a equipe confirma chegada sem finalizar serviço, liberar horário nem registrar pagamento",async()=>{
    const a=await company();
    const day=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
    const startsAt=localToUtc("America/Bahia",day,10*60).toISOString().replace(/\.\d{3}Z$/,"Z");
    const created=await createBooking(a.ctx,{serviceId:a.serviceId,barberId:a.barberId,
      startsAt,name:"Cliente chegou",phone:"5573999991432",consent:true,whatsappOptin:false,
      idempotencyKey:crypto.randomUUID()});
    expect(created.ok).toBe(true);
    if(!created.ok)throw Error(created.message);
    const admin={...a.ctx,origin:"admin" as const};
    const at=new Date(Date.parse(startsAt)-20*60000);
    expect(await markBookingArrived(admin,created.bookingId,new Date(Date.parse(startsAt)-3*3600000)))
      .toMatchObject({ok:false,status:409});
    expect(await markBookingArrived(a.ctx,created.bookingId,at))
      .toMatchObject({ok:false,status:403});
    const done=await markBookingArrived(admin,created.bookingId,at);
    expect(done).toMatchObject({ok:true,checkedInAt:at.toISOString().replace(/\.\d{3}Z$/,"Z")});
    expect(await markBookingArrived(admin,created.bookingId,at))
      .toMatchObject({ok:false,status:409});
    const status=await db.prepare("SELECT status,checked_in_at,cancel_reason,notes FROM bookings WHERE id=?1")
      .bind(created.bookingId).first<{status:string;checked_in_at:string;cancel_reason:string;notes:string}>();
    expect(status?.status).toBe("confirmado");
    expect(status?.checked_in_at).toBe(at.toISOString().replace(/\.\d{3}Z$/,"Z"));
    expect(status?.cancel_reason).toBe("");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM booking_slots WHERE booking_id=?1")
      .bind(created.bookingId).first<number>("n")).toBeGreaterThan(0);
    const cancelled=await cancelBooking(admin,created.bookingId,{
      reason:"Avisou pelo WhatsApp — mudança de planos",actorRole:"admin"});
    expect(cancelled).toMatchObject({ok:true});
    const after=await db.prepare("SELECT status,cancel_reason,notes FROM bookings WHERE id=?1")
      .bind(created.bookingId).first<{status:string;cancel_reason:string;notes:string}>();
    expect(after?.status).toBe("cancelado");
    expect(after?.cancel_reason).toBe("Avisou pelo WhatsApp — mudança de planos");
    expect(after?.notes).toBe("");
    expect(await db.prepare("SELECT COUNT(*) AS n FROM booking_slots WHERE booking_id=?1")
      .bind(created.bookingId).first<number>("n")).toBe(0);
    expect(await markBookingArrived(admin,created.bookingId,at)).toMatchObject({ok:false,status:409});
  });
  it("não permite registrar chegada de reserva pertencente a outra empresa",async()=>{
    const a=await company(),b=await company();
    const day=new Date(Date.now()+6*86400000).toISOString().slice(0,10);
    const startsAt=localToUtc("America/Bahia",day,10*60).toISOString().replace(/\.\d{3}Z$/,"Z");
    const created=await createBooking(a.ctx,{serviceId:a.serviceId,barberId:a.barberId,
      startsAt,name:"Cliente separado",phone:"5573999991433",consent:true,whatsappOptin:false,
      idempotencyKey:crypto.randomUUID()});
    if(!created.ok)throw Error(created.message);
    const at=new Date(Date.parse(startsAt)-600000);
    expect(await markBookingArrived({...b.ctx,origin:"admin"},created.bookingId,at))
      .toMatchObject({ok:false,status:404});
    const still=await db.prepare("SELECT checked_in_at FROM bookings WHERE id=?1")
      .bind(created.bookingId).first<{checked_in_at:string|null}>();
    expect(still?.checked_in_at).toBeNull();
  });
});


describe("chegada informada pelo próprio cliente",()=>{
  it("só aceita confirmação com prova verificada e janela próxima ao atendimento",async()=>{
    const a=await company();
    const day=new Date(Date.now()+5*86400000).toISOString().slice(0,10);
    const startsAt=localToUtc("America/Bahia",day,10*60).toISOString().replace(/\.\d{3}Z$/,"Z");
    const created=await createBooking(a.ctx,{serviceId:a.serviceId,barberId:a.barberId,
      startsAt,name:"Cliente presencial",phone:"5573999991434",consent:true,whatsappOptin:false,
      idempotencyKey:crypto.randomUUID()});
    if(!created.ok)throw Error(created.message);
    const at=new Date(Date.parse(startsAt)-15*60000);
    expect(await markBookingArrived(a.ctx,created.bookingId,at))
      .toMatchObject({ok:false,status:403});
    expect(await markBookingArrived(a.ctx,created.bookingId,
      new Date(Date.parse(startsAt)-60*60000),true)).toMatchObject({ok:false,status:409});
    expect(await markBookingArrived(a.ctx,created.bookingId,at,true)).toMatchObject({ok:true});
    const b=await db.prepare("SELECT status,checked_in_source,checked_in_by_user_id,checked_in_at FROM bookings WHERE id=?1")
      .bind(created.bookingId).first<{status:string;checked_in_source:string;checked_in_by_user_id:number|null;checked_in_at:string}>();
    expect(b?.status).toBe("confirmado");
    expect(b?.checked_in_source).toBe("cliente");
    expect(b?.checked_in_by_user_id).toBeNull();
    expect(b?.checked_in_at).toBe(at.toISOString().replace(/\.\d{3}Z$/,"Z"));
    expect(await markBookingArrived({...a.ctx,origin:"admin"},created.bookingId,at))
      .toMatchObject({ok:false,status:409});
  });
});
