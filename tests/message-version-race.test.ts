/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll,describe,expect,it,vi } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { scheduleBookingMessage,cancelPendingJobs,processDueJobs } from "../api/lib/messaging/jobs";
import { DEFAULT_SETTINGS } from "../api/lib/settings";
import { ensureWallet } from "../api/lib/wallet";
import { mockProvider } from "../api/lib/messaging/provider";
import type { BookingRow } from "../api/lib/messaging/types";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
beforeAll(async()=>{for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean))await db.prepare(sql).run();});
function beforeRunDatabase(match:(sql:string)=>boolean,action:()=>Promise<void>):D1Database {
  let fired=false;
  const wrap=(stmt:D1PreparedStatement):D1PreparedStatement=>({
    bind(...values:unknown[]){return wrap(stmt.bind(...values));},
    async run(){if(!fired){fired=true;await action();}return stmt.run();},
  } as D1PreparedStatement);
  return {prepare(sql:string){const stmt=db.prepare(sql);return match(sql)?wrap(stmt):stmt;},batch:(statements:D1PreparedStatement[])=>db.batch(statements)} as D1Database;
}
async function fixture(){
  const companyId=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Mensagens locais')").bind(crypto.randomUUID()).run()).meta.last_row_id);
  const barber=Number((await db.prepare("INSERT INTO barbers(company_id,slug,name) VALUES (?1,'barber','Barbeiro')").bind(companyId).run()).meta.last_row_id);
  const service=Number((await db.prepare("INSERT INTO services(company_id,slug,name,price_cents,duration_min) VALUES (?1,'corte','Corte',1999,30)").bind(companyId).run()).meta.last_row_id);
  const starts=new Date(Date.now()+3*86400000),iso=(d:Date)=>d.toISOString().replace(/\.\d{3}Z$/,"Z");
  const id=Number((await db.prepare("INSERT INTO bookings(company_id,barber_id,service_id,code,starts_at,ends_at,price_cents,status,customer_name,customer_phone,whatsapp_optin,cancel_token) VALUES (?1,?2,?3,?4,?5,?6,1999,'pendente','Cliente','5573999990000',1,'private')")
    .bind(companyId,barber,service,crypto.randomUUID(),iso(starts),iso(new Date(starts.getTime()+1800000))).run()).meta.last_row_id);
  await db.prepare("INSERT INTO subscriptions(company_id,plan_code,status,period_end) VALUES (?1,'pro','active',?2)").bind(companyId,iso(new Date(starts.getTime()+86400000))).run();
  await db.prepare("INSERT INTO whatsapp_connections(company_id,provider,status) VALUES (?1,'mock','connected')").bind(companyId).run();
  await db.prepare("INSERT INTO whatsapp_templates(company_id,code,body_text) VALUES (?1,'tigu_lembrete','Seu horário está chegando')").bind(companyId).run();
  await ensureWallet(db,companyId);
  await db.prepare("UPDATE wallets SET balance_cents=1000 WHERE company_id=?1").bind(companyId).run();
  const booking:BookingRow={id,company_id:companyId,code:"TESTE",customer_name:"Cliente",customer_phone:"5573999990000",whatsapp_optin:1,starts_at:iso(starts),status:"pendente",schedule_version:1};
  const settings={...DEFAULT_SETTINGS},e={...env,DB:db,APP_ENV:"development",WHATSAPP_MOCK:"1"} as Env;
  const moved=iso(new Date(starts.getTime()+3600000));
  const move=async()=>{await db.prepare("UPDATE bookings SET starts_at=?1,ends_at=?2,schedule_version=2 WHERE id=?3").bind(moved,iso(new Date(starts.getTime()+5400000)),id).run();};
  const schedule=(snap=booking,database=db)=>scheduleBookingMessage({db:database,companyId,booking:snap,settings,kind:"reminder"});
  const jobs=()=>db.prepare("SELECT id,status,idempotency_key,reserved_cents FROM message_jobs WHERE company_id=?1 ORDER BY id").bind(companyId).all<{id:number;status:string;idempotency_key:string;reserved_cents:number}>();
  return {id,companyId,booking,settings,e,move,moved,schedule,jobs,due:new Date(starts.getTime()-30*60000)};
}
describe("mensagens seguem a versão atual do atendimento",()=>{
  it("snapshot antigo não cancela o lembrete da remarcação mais recente",async()=>{
    const f=await fixture();await f.schedule();await f.move();
    await f.schedule({...f.booking,starts_at:f.moved,schedule_version:2});
    expect((await f.schedule()).status).toBe("skipped");
    expect((await f.jobs()).results.map(j=>j.status)).toEqual(["cancelled","scheduled"]);
    expect(await db.prepare("SELECT reserved_cents FROM wallets WHERE company_id=?1").bind(f.companyId).first("reserved_cents")).toBe(10);
  });
  it("cancelamento atrasado de versões antigas preserva job de versão futura",async()=>{
    const f=await fixture();await f.move();await f.schedule({...f.booking,starts_at:f.moved,schedule_version:2});
    await cancelPendingJobs(db,f.companyId,f.id,null,"operação atrasada",undefined,2);
    expect((await f.jobs()).results[0].status).toBe("scheduled");
  });
  it("remarcação entre leitura e inserção impede enfileirar payload antigo",async()=>{
    const f=await fixture();
    const proxy=beforeRunDatabase(sql=>sql.includes("INSERT OR IGNORE INTO message_jobs"),f.move);
    expect((await f.schedule(f.booking,proxy)).status).toBe("skipped");
    expect((await f.jobs()).results).toHaveLength(0);
    expect(await db.prepare("SELECT reserved_cents FROM wallets WHERE company_id=?1").bind(f.companyId).first("reserved_cents")).toBe(0);
  });
  it("dispatch descarta versão antiga e libera a reserva sem chamar provedor",async()=>{
    const f=await fixture();await f.schedule();await f.move();
    const send=vi.spyOn(mockProvider,"sendTemplate");
    try {
      const result=await processDueJobs(f.e,{companyId:f.companyId,now:f.due});
      expect(result.skipped).toBe(1);expect(send).not.toHaveBeenCalled();
      expect((await f.jobs()).results[0]).toMatchObject({status:"skipped",reserved_cents:0});
    } finally {send.mockRestore();}
  });
  it("claim revalida versão para cobrir remarcação ocorrida após a leitura",async()=>{
    const f=await fixture();await f.schedule();
    const proxy=beforeRunDatabase(sql=>sql.includes("UPDATE message_jobs SET status='sending',attempts"),f.move);
    const send=vi.spyOn(mockProvider,"sendTemplate");
    try {
      await processDueJobs({...f.e,DB:proxy},{companyId:f.companyId,now:f.due});
      expect(send).not.toHaveBeenCalled();
      expect((await f.jobs()).results[0].status).toBe("scheduled");
      await processDueJobs(f.e,{companyId:f.companyId,now:f.due});
      expect((await f.jobs()).results[0]).toMatchObject({status:"skipped",reserved_cents:0});
    } finally {send.mockRestore();}
  });
  it("cancelamento não libera créditos de job já assumido por outro Worker",async()=>{
    const f=await fixture();await f.schedule();const job=(await f.jobs()).results[0];
    const proxy=beforeRunDatabase(sql=>sql.includes("UPDATE message_jobs SET status='cancelled'"),async()=>{await db.prepare("UPDATE message_jobs SET status='sending' WHERE id=?1").bind(job.id).run();});
    await cancelPendingJobs(proxy,f.companyId,f.id,null,"cancelamento concorrente");
    expect((await f.jobs()).results[0]).toMatchObject({status:"sending",reserved_cents:10});
    expect(await db.prepare("SELECT reserved_cents FROM wallets WHERE company_id=?1").bind(f.companyId).first("reserved_cents")).toBe(10);
  });
  it.each(["expired","suspended"])("não envia mensagens automáticas com acesso %s",async mode=>{
    const f=await fixture();await f.schedule();
    if(mode==="expired")await db.prepare("UPDATE subscriptions SET period_end='2000-01-01T00:00:00Z' WHERE company_id=?1").bind(f.companyId).run();
    else await db.prepare("UPDATE companies SET status='suspended' WHERE id=?1").bind(f.companyId).run();
    const send=vi.spyOn(mockProvider,"sendTemplate");
    try {
      await processDueJobs(f.e,{companyId:f.companyId,now:f.due});
      expect(send).not.toHaveBeenCalled();
      expect((await f.jobs()).results[0]).toMatchObject({status:"skipped",reserved_cents:0});
      expect(await db.prepare("SELECT reserved_cents FROM wallets WHERE company_id=?1").bind(f.companyId).first("reserved_cents")).toBe(0);
    } finally {send.mockRestore();}
  });
  it("claim recusa downgrade que ocorreu após consultar o plano",async()=>{
    const f=await fixture();await f.schedule();
    const proxy=beforeRunDatabase(sql=>sql.includes("UPDATE message_jobs SET status='sending',attempts"),async()=>{
      await db.prepare("UPDATE subscriptions SET plan_code='free' WHERE company_id=?1").bind(f.companyId).run();
    });
    const send=vi.spyOn(mockProvider,"sendTemplate");
    try {
      await processDueJobs({...f.e,DB:proxy},{companyId:f.companyId,now:f.due});
      expect(send).not.toHaveBeenCalled();expect((await f.jobs()).results[0].status).toBe("scheduled");
      await processDueJobs(f.e,{companyId:f.companyId,now:f.due});
      expect((await f.jobs()).results[0]).toMatchObject({status:"skipped",reserved_cents:0});
    } finally {send.mockRestore();}
  });
  it("cota mensal é conferida novamente no claim contando envios assumidos",async()=>{
    const f=await fixture();await f.schedule();const job=(await f.jobs()).results[0];
    const plan=`quota-${crypto.randomUUID()}`;
    await db.prepare("INSERT INTO plans(code,name,price_cents_month,max_barbers,max_messages_month,whatsapp_enabled) VALUES (?1,'Cota local',1999,10,1,1)").bind(plan).run();
    await db.prepare("UPDATE subscriptions SET plan_code=?1 WHERE company_id=?2").bind(plan,f.companyId).run();
    const proxy=beforeRunDatabase(sql=>sql.includes("UPDATE message_jobs SET status='sending',attempts"),async()=>{
      await db.prepare(`INSERT INTO message_jobs(company_id,kind,booking_id,to_phone,template_code,payload_json,status,scheduled_at,fire_deadline,price_cents,cost_cents,idempotency_key,last_attempt_at)
        SELECT company_id,'manual',NULL,to_phone,template_code,'{}','sending',scheduled_at,fire_deadline,0,0,?1,?2 FROM message_jobs WHERE id=?3`)
        .bind(`occupied-${crypto.randomUUID()}`,f.due.toISOString().replace(/\.\d{3}Z$/,"Z"),job.id).run();
    });
    const send=vi.spyOn(mockProvider,"sendTemplate");
    try {
      await processDueJobs({...f.e,DB:proxy},{companyId:f.companyId,now:f.due});
      expect(send).not.toHaveBeenCalled();
      expect((await f.jobs()).results[0]).toMatchObject({status:"scheduled",reserved_cents:10});
      expect(await db.prepare("SELECT lifetime_charged_cents FROM wallets WHERE company_id=?1").bind(f.companyId).first("lifetime_charged_cents")).toBe(0);
    } finally {send.mockRestore();}
  });
  it("restrição do plano não sobrescreve envio que outro Worker já assumiu",async()=>{
    const f=await fixture();await f.schedule();const job=(await f.jobs()).results[0];
    await db.prepare("UPDATE subscriptions SET plan_code='free' WHERE company_id=?1").bind(f.companyId).run();
    const proxy=beforeRunDatabase(sql=>sql.includes("skip_reason='plano sem WhatsApp'"),async()=>{
      await db.prepare("UPDATE message_jobs SET status='sending' WHERE id=?1").bind(job.id).run();
    });
    await processDueJobs({...f.e,DB:proxy},{companyId:f.companyId,now:f.due});
    expect((await f.jobs()).results[0]).toMatchObject({status:"sending",reserved_cents:10});
    expect(await db.prepare("SELECT reserved_cents FROM wallets WHERE company_id=?1").bind(f.companyId).first("reserved_cents")).toBe(10);
  });
});
