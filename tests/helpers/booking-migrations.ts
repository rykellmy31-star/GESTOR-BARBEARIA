import mutationSchema from "../../migrations/0009_booking_mutation_token.sql";
import daySchema from "../../migrations/0010_booking_local_day_guard.sql";
import checkoutSchema from "../../migrations/0018_booking_checkout.sql";
import orderPaidSchema from "../../migrations/0011_order_paid_at.sql";
import merchantSchema from "../../migrations/0019_merchant_payments.sql";
import fitInSchema from "../../migrations/0020_last_minute_fit_in.sql";
import sellerOauthSchema from "../../migrations/0099_seller_mercadopago_oauth.sql";
import sellerPixSchema from "../../migrations/0100_seller_pix.sql";
import barberDurationSchema from "../../migrations/0101_barber_service_duration.sql";
import bookingCheckinSchema from "../../migrations/0102_booking_checkin_cancel_reason.sql";
/** Completa as fixtures antigas que carregam a base 0001 diretamente. */
export async function applyBookingMigrations(db:D1Database):Promise<void> {
  const columns=new Set((await db.prepare("PRAGMA table_info(bookings)").all<{name:string}>()).results.map(row=>row.name));
  if(!columns.has("mutation_token"))await db.prepare(mutationSchema.replace(/--[^\n]*/g,"").trim()).run();
  if(!columns.has("local_day"))await db.prepare(daySchema.match(/ALTER TABLE[^;]+;/)![0]).run();
  for(const trigger of daySchema.match(/CREATE TRIGGER[\s\S]+?END;/g)!)await db.prepare(trigger).run();
  if(!columns.has("payment_choice")) {
    await db.prepare(checkoutSchema.match(/ALTER TABLE[\s\S]+?;/)![0]).run();
    for(const sql of checkoutSchema.match(/CREATE TABLE[\s\S]+?\);|CREATE INDEX[^;]+;|CREATE TRIGGER[\s\S]+?END;/g)!)
      await db.prepare(sql).run();
  }
  if(!columns.has("scheduled_ends_at")){
    const sql=fitInSchema.replace(/--[^\n]*/g,"").split(";").map(x=>x.trim()).filter(Boolean);
    for(const statement of sql)await db.prepare(statement).run();
  }
  const orderColumns=new Set((await db.prepare("PRAGMA table_info(orders)").all<{name:string}>()).results.map(row=>row.name));
  if(!orderColumns.has("paid_at")) await db.prepare(orderPaidSchema.match(/ALTER TABLE[^;]+;/)![0]).run();
  if(!orderColumns.has("payment_choice")){
    const triggers=merchantSchema.match(/CREATE TRIGGER[\s\S]+?END;/g)||[];
    const remaining=merchantSchema.replace(/--[^\n]*/g,"").replace(/CREATE TRIGGER[\s\S]+?END;/g,"");
    for(const sql of remaining.split(";").map(x=>x.trim()).filter(Boolean))await db.prepare(sql).run();
    for(const sql of triggers)await db.prepare(sql).run();
  }
  const sellerTables=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='seller_mp_accounts'").first();
  if(!sellerTables)for(const sql of sellerOauthSchema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean))
    await db.prepare(sql).run();
  const receiverColumns=new Set((await db.prepare("PRAGMA table_info(booking_payments)").all<{name:string}>()).results.map(row=>row.name));
  if(!receiverColumns.has("receiver_barber_id")){
    const triggers=sellerPixSchema.match(/CREATE TRIGGER[\s\S]+?END;/g)||[];
    const remaining=sellerPixSchema.replace(/--[^\n]*/g,"").replace(/CREATE TRIGGER[\s\S]+?END;/g,"");
    for(const statement of remaining.split(";").map(x=>x.trim()).filter(Boolean))await db.prepare(statement).run();
    for(const trigger of triggers)await db.prepare(trigger).run();
  }

  const durationColumns=await db.prepare("PRAGMA table_info(service_barbers)").all<{name:string}>();
  if(!durationColumns.results.some(c=>c.name==="duration_override_min"))
    await db.prepare(barberDurationSchema.replace(/--[^\n]*/g,"").trim()).run();
  const bookingColumns=new Set((await db.prepare("PRAGMA table_info(bookings)")
    .all<{name:string}>()).results.map(row=>row.name));
  if(!bookingColumns.has("checked_in_at"))
    for(const statement of bookingCheckinSchema.replace(/--[^\n]*/g,"")
      .split(";").map(x=>x.trim()).filter(Boolean))
      await db.prepare(statement).run();
}
