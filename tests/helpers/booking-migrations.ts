import mutationSchema from "../../migrations/0009_booking_mutation_token.sql";
import daySchema from "../../migrations/0010_booking_local_day_guard.sql";
import checkoutSchema from "../../migrations/0018_booking_checkout.sql";
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
}
