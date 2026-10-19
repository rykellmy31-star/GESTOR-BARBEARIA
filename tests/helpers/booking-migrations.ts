import mutationSchema from "../../migrations/0009_booking_mutation_token.sql";
import daySchema from "../../migrations/0010_booking_local_day_guard.sql";
/** Completa as fixtures antigas que carregam a base 0001 diretamente. */
export async function applyBookingMigrations(db:D1Database):Promise<void> {
  const columns=new Set((await db.prepare("PRAGMA table_info(bookings)").all<{name:string}>()).results.map(row=>row.name));
  if(!columns.has("mutation_token"))await db.prepare(mutationSchema.replace(/--[^\n]*/g,"").trim()).run();
  if(!columns.has("local_day"))await db.prepare(daySchema.match(/ALTER TABLE[^;]+;/)![0]).run();
  for(const trigger of daySchema.match(/CREATE TRIGGER[\s\S]+?END;/g)!)await db.prepare(trigger).run();
}
