/// <reference types="@cloudflare/vitest-pool-workers" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { createBooking, type BookingMutationCtx } from "../api/lib/booking";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { localToUtc } from "../api/lib/time";
import type { Env } from "../api/types";

const db = env.DB as D1Database;
beforeAll(async () => {
  for (const sql of schema.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean))
    await db.prepare(sql).run();
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
