// ============================================================================
// SEED DEMO TIGU — dados FICTÍCIOS claramente marcados (demo=1) em todas as
// tabelas. Serve para: rodar a plataforma local, gravar screenshots e validar
// o motor (agenda, mensagens, carteira) sem tocar em provedores reais.
// Idempotente: purga e recria. Nomes/e-mails usam domínio .demo / .dev.
// ============================================================================
import type { D1Database } from "@cloudflare/workers-types";
import { nowIso } from "./utils";
import { hashPassword } from "./crypto";
import { DEFAULT_SETTINGS } from "./settings";
import { localToUtc } from "./time";

const DEMO_TZ = "America/Bahia";
const rnd = (n: number) => Math.floor(Math.random() * n);
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

interface DemoCompanySpec {
  slug: string;
  name: string;
  plan: "free" | "pro" | "scale";
  tagline: string;
  brand: { gold: string; ink: string; panel: string; line: string };
  owner_email: string;
  suspended?: boolean;
}

const COMPANIES: DemoCompanySpec[] = [
  { slug: "estilo-premium", name: "Barbearia Estilo Premium", plan: "pro", tagline: "Tradição e navalha desde 2012", brand: { gold: "#d4af37", ink: "#0a0a0c", panel: "#16161c", line: "#26262f" }, owner_email: "dono@estilopremium.demo" },
  { slug: "corte-fino", name: "Corte Fino Barbearia", plan: "scale", tagline: "Seu corte, nosso compromisso", brand: { gold: "#34d399", ink: "#05130d", panel: "#0b241a", line: "#164532" }, owner_email: "dono@cortefino.demo" },
  { slug: "navalha-azul", name: "Navalha Azul", plan: "free", tagline: "Simples, rápido, bem feito", brand: { gold: "#60a5fa", ink: "#0a0f1e", panel: "#111a33", line: "#1f2c52" }, owner_email: "dono@navalhaazul.demo" },
];

/** Semeia as 3 barbearias demo + superadmin. Retorna contagens. */
export async function seedDemo(env: { DB: D1Database }): Promise<Record<string, number>> {
  const db = env.DB;
  await purgeDemo(db);

  const superHash = await hashPassword("Tigu#Super2026");
  const ownerHash = await hashPassword("Demo!Barber2026");
  const barberHash = await hashPassword("Demo!Barber2026");

  const insSuper = await db.prepare(`INSERT INTO users (platform_role, name, email, password_hash, active, demo, created_at) VALUES ('superadmin','Operador Tigu','admin@tigu.dev',?1,1,1,?2)`)
    .bind(superHash, nowIso()).run();
  void insSuper;

  const stats: Record<string, number> = { companies: 0, bookings: 0, messages: 0, credits_tx: 0 };
  const perCompany: Record<string, unknown> = {};

  for (const spec of COMPANIES) {
    const created = await seedOneCompany(db, spec, ownerHash, barberHash);
    perCompany[spec.slug] = created;
    stats.companies++;
    stats.bookings += created.bookings;
    stats.messages += created.messages;
    stats.credits_tx += created.credits_tx;
  }
  return { ...stats, superadmin_id: 1 } as Record<string, number>;
}

async function seedOneCompany(db: D1Database, spec: DemoCompanySpec, ownerHash: string, barberHash: string) {
  const now = nowIso();
  const insCo = await db.prepare(`INSERT INTO companies (slug, name, status, suspend_reason, plan_code, demo, created_at, updated_at) VALUES (?1,?2,?3,?4,?5,1,?6,?6)`)
    .bind(spec.slug, spec.name, spec.suspended ? "suspended" : "active", spec.suspended ? "Demonstração de suspensão pela plataforma" : "", spec.plan, now).run();
  const companyId = insCo.meta.last_row_id as number;

  const settings = {
    ...DEFAULT_SETTINGS,
    shop_name: spec.name,
    tagline: spec.tagline,
    about: "Ambiente de DEMONSTRAÇÃO da plataforma Tigu — todos os dados abaixo são fictícios. Agenda, loja e carteirinha de créditos funcionando de verdade para você testar o produto.",
    phone: "(75) 3200-0000",
    whatsapp: "75999000000",
    email: `contato@${spec.slug}.demo`,
    address: "Rua das Tesouras, 123 — Centro",
    maps_query: `Rua das Tesouras 123 centro`,
    brand: spec.brand,
    code_prefix: "TGU",
    products_enabled: true,
    reviews_enabled: true,
    whatsapp_reminders_enabled: true,
    whatsapp_confirm_enabled: spec.plan !== "free",
    timezone: DEMO_TZ,
  };
  await db.batch([
    db.prepare(`INSERT INTO company_settings (company_id, data, updated_at) VALUES (?1,?2,?3)`).bind(companyId, JSON.stringify(settings), now),
    db.prepare(`INSERT OR IGNORE INTO wallets (company_id, updated_at) VALUES (?1,?2)`).bind(companyId, now),
    db.prepare(`INSERT INTO subscriptions (company_id, plan_code, status, started_at, period_end, updated_at) VALUES (?1,?2,'active',?3,?4,?3)`).bind(companyId, spec.plan, now, `${(new Date().getUTCFullYear() + 1)}-01-01T00:00:00Z`),
  ]);

  // dono
  const insOwner = await db.prepare(`INSERT INTO users (platform_role, name, email, password_hash, active, demo, created_at) VALUES ('user',?1,?2,?3,1,1,?4)`)
    .bind(`${spec.name.split(" ").pop()} Proprietário`, `dono@${spec.slug}.demo`, ownerHash, now).run();
  const ownerId = insOwner.meta.last_row_id as number;
  await db.prepare(`INSERT INTO company_memberships (company_id, user_id, role, active, created_at) VALUES (?1,?2,'owner',1,?3)`).bind(companyId, ownerId, now).run();

  // barbeiros (2 usuários de painel + 1 sem usuário)
  const barberNames = ["Rafael Lima", "Diego Santos", "Marina Alves"];
  const barberIds: number[] = [];
  for (let i = 0; i < 3; i++) {
    const slug = spec.slug === "corte-fino" ? `barbeiro${i + 1}` : `prof${i + 1}-${spec.slug}`;
    const ins = await db.prepare(`INSERT INTO barbers (company_id, slug, name, specialty, bio, photo, work_days, work_start, work_end, break_start, break_end, rating, reviews_count, active, sort, demo, created_at)
                                  VALUES (?1,?2,?3,?4,?5,'',?6,'09:00','20:00','12:00','13:00',?7,?8,1,?9,1,?10)`)
      .bind(companyId, uniqueOr(slug, i), barberNames[i], ["Cortes clássicos", "Barba & navalha", "Freestyle & coloração"][i], "Profissional demo da barbearia fictícia.", "[1,2,3,4,5,6]", 4.6 + i * 0.15, 12 + i * 5, i, now).run();
    barberIds.push(ins.meta.last_row_id as number);
  }

  // serviços
  const services = [
    ["corte-masculino", "Corte Masculino", 4500, 45, "cabelo"],
    ["corte-barba", "Corte + Barba", 6500, 75, "cabelo"],
    ["barba-navalha", "Barba na Navalha", 3500, 40, "barba"],
    ["pezinho", "Pezinho / Acabamento", 1500, 15, "cabelo"],
    ["platinado", "Descoloração Platinado", 12000, 120, "quimica"],
  ] as const;
  const serviceIds: number[] = [];
  for (const [slug, name, price, dur, cat] of services) {
    const ins = await db.prepare(`INSERT INTO services (company_id, slug, name, description, price_cents, duration_min, category, active, show_in_catalog, sort, demo, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,1,1,?8,1,?9)`)
      .bind(companyId, `${slug}`, `${name}`, `Serviço de demonstração (${spec.name}).`, price, dur, cat, serviceIds.length, now).run();
    serviceIds.push(ins.meta.last_row_id as number);
    for (const bid of barberIds) await db.prepare(`INSERT OR IGNORE INTO service_barbers (service_id, barber_id) VALUES (?1,?2)`).bind(ins.meta.last_row_id, bid).run();
  }

  // produtos
  const products = [["Pomada Modeladora 120g", 3990, 24], ["Óleo de Barba Cedro", 4990, 15], ["Shampoo Barba Forte", 3490, 30], ["Lâmina de Segurança", 8990, 6]];
  const productIds: number[] = [];
  for (let i = 0; i < products.length; i++) {
    const [name, price, stock] = products[i];
    const ins = await db.prepare(`INSERT INTO products (company_id, slug, name, description, price_cents, stock, category, active, featured, demo, created_at) VALUES (?1,?2,?3,'Produto fictício para demonstração da loja.',?4,?5,'cuidados',1,?6,1,?7)`)
      .bind(companyId, `demo-prod-${spec.slug}-${i + 1}`, name, price, stock, i === 0 ? 1 : 0, now).run();
    productIds.push(ins.meta.last_row_id as number);
    await db.prepare(`INSERT INTO stock_movements (company_id, product_id, delta, reason, ref, created_at) VALUES (?1,?2,?3,'entrada','Seed demo',?4)`).bind(companyId, ins.meta.last_row_id, stock, now).run();
  }

  // clientes + agendamentos (histórico + hoje + futuros)
  const customers = [
    ["João Pereira", "75991110001"], ["Carlos Souza", "75991110002"], ["Bruno Dias", "75991110003"],
    ["André Nunes", "75991110004"], ["Felipe Ramos", "75991110005"], ["Marcos Vinícius", "75991110006"],
  ] as const;
  const custIds: number[] = [];
  for (const [name, phone] of customers) {
    const ins = await db.prepare(`INSERT INTO customers (company_id, name, phone, email, whatsapp_optin, lgpd_consent_at, demo, created_at) VALUES (?1,?2,?3,?4,1,?5,1,?5)`)
      .bind(companyId, name, phone, `${name.split(" ")[0].toLowerCase()}@exemplo.demo`, now).run();
    custIds.push(ins.meta.last_row_id as number);
  }

  // templates (mock connected)
  await db.batch([
    db.prepare(`INSERT INTO whatsapp_connections (company_id, provider, status, display_phone, business_name, coexistence, demo, connected_at, created_at, updated_at) VALUES (?1,'mock','connected',?2,?3,'enabled',1,?4,?4,?4)`)
      .bind(companyId, `55${settings.whatsapp}`, spec.name, now),
    db.prepare(`INSERT INTO whatsapp_templates (company_id, code, language, category, status, body_text, variables_n, use_case, active, demo, updated_at) VALUES (?1,'tigu_lembrete','pt_BR','utility','approved',?2,4,'reminder',1,1,?3)`)
      .bind(companyId, "Olá {{1}}! Passando para lembrar do seu horário: {{2}} com {{3}} em {{4}} na {{5}}. Até já! (protocolo {{6}})", now),
    db.prepare(`INSERT INTO whatsapp_templates (company_id, code, language, category, status, body_text, variables_n, use_case, active, demo, updated_at) VALUES (?1,'tigu_confirmacao','pt_BR','utility','approved',?2,3,'confirmation',1,1,?3)`)
      .bind(companyId, "Oi {{1}}! Confirmamos seu {{2}} com {{3}}. Qualquer coisa é só chamar.", now),
  ]);

  const bookings = await seedBookings(db, companyId, spec, barberIds, serviceIds, customers, custIds, settings);
  await seedMessages(db, companyId, bookings);
  await seedWalletHistory(db, companyId, spec);

  // pedidos da loja
  for (let i = 0; i < 2; i++) {
    const code = `PED-${spec.slug.slice(0, 3).toUpperCase()}${1000 + i}`;
    const ins = await db.prepare(`INSERT INTO orders (company_id, code, customer_name, customer_phone, channel, status, total_cents, demo, created_at, updated_at) VALUES (?1,?2,?3,?4,'online',?5,?6,1,?7,?7)`)
      .bind(companyId, code, customers[i][0], customers[i][1], i === 0 ? "novo" : "pago", 8480, now).run();
    await db.batch([
      db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, qty, unit_price_cents) VALUES (?1,?2,?3,1,3990)`).bind(ins.meta.last_row_id, productIds[0], products[0][0]),
      db.prepare(`INSERT INTO order_items (order_id, product_id, product_name, qty, unit_price_cents) VALUES (?1,?2,?3,1,3490)`).bind(ins.meta.last_row_id, productIds[2], products[2][0]),
    ]);
  }
  // um pedido de folga pendente
  await db.prepare(`INSERT INTO block_requests (company_id, barber_id, date, start_min, end_min, reason, status, demo, created_at) VALUES (?1,?2,?3,780,840,'Consulta particular',?4,1,?5)`)
    .bind(companyId, barberIds[0], isoStr(addDaysLocal(new Date(), 2)), "pendente", now).run();
  // reviews p/ barbeiros
  for (const [bi, bid] of barberIds.entries()) {
    await db.prepare(`INSERT INTO reviews (company_id, barber_id, booking_id, customer_name, rating, comment, demo, created_at) VALUES (?1,?2,NULL,?3,5,?4,1,?5)`)
      .bind(companyId, bid, customers[bi % customers.length][0], "Atendimento nota 10 (avaliação fictícia de demonstração).", now).run();
    await db.prepare(`UPDATE barbers SET rating = (SELECT ROUND(AVG(rating),2) FROM reviews WHERE barber_id=?1), reviews_count = (SELECT COUNT(*) FROM reviews WHERE barber_id=?1) WHERE id=?1`).bind(bid).run();
  }
  // notificação de boas-vindas
  await db.prepare(`INSERT INTO notifications (company_id, audience, title, body, kind, demo) VALUES (?1,'admin','Demonstração Tigu','Este painel contém dados fictícios (marcados como demo). Nenhum valor financeiro é real.','system',1)`).bind(companyId).run();

  return { company_id: companyId, bookings: bookings.length, messages: bookings.length, credits_tx: 3 };
}
function isoStr(d: Date) { return d.toISOString().slice(0, 10); }
function addDaysLocal(d: Date, n: number) { return new Date(d.getTime() + n * 86400_000); }
function uniqueOr(slug: string, i: number) { return slug; }

async function seedBookings(db: D1Database, companyId: number, spec: DemoCompanySpec, barberIds: number[], serviceIds: number[], customers: readonly (readonly string[])[], custIds: number[], settings: Record<string, unknown>) {
  const now = new Date();
  const created: { id: number; starts_at: string; code: string; barber_id: number; status: string }[] = [];
  const plan: Record<string, string[]> = {
    "estilo-premium": ["concluido", "concluido", "confirmado", "pendente", "cancelado", "pendente"],
    "corte-fino": ["concluido", "confirmado", "pendente", "no_show", "pendente"],
    "navalha-azul": ["concluido", "pendente"],
  };
  const statuses = plan[spec.slug] ?? ["pendente"];
  for (let i = 0; i < statuses.length; i++) {
    const status = statuses[i];
    const dayOffset = status === "concluido" ? -(2 + i) : status === "cancelado" ? -1 : status === "no_show" ? -1 : status === "confirmado" ? 0 : 1 + (i % 3);
    const day = new Date(now.getTime() + dayOffset * 86400_000).toISOString().slice(0, 10);
    const startMin = 10 * 60 + (i % 4) * 45; // 10:00, 10:45, 11:30, 12:15 (varia p/ não bater almoço sempre)
    const barberId = barberIds[i % barberIds.length];
    const serviceId = serviceIds[i % serviceIds.length];
    const durationMin = [45, 75, 40, 15, 120][i % 5];
    const price = [4500, 6500, 3500, 1500, 12000][i % 5];
    const startsAt = localToUtc(DEMO_TZ, day, startMin).toISOString().replace(/\.\d{3}Z$/, "Z");
    const endsAt = localToUtc(DEMO_TZ, day, startMin + durationMin).toISOString().replace(/\.\d{3}Z$/, "Z");
    const code = `TGU-${Array.from(crypto.getRandomValues(new Uint8Array(4))).map((b) => b.toString(36).toUpperCase().padStart(2, "0").replace(/[^A-Z0-9]/g, "X")).join("").slice(0, 8)}`;
    try {
      const ins = await db.prepare(`INSERT INTO bookings (company_id, code, customer_id, barber_id, service_id, starts_at, ends_at, price_cents, status, origin, customer_name, customer_phone, notes, whatsapp_optin, schedule_version, cancel_token, allowed_cancel_until, demo, created_at, updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,'cliente',?10,?11,'Reserva fictícia de demonstração.',1,1,'demo-token',?12,1,?13,?13)`)
        .bind(companyId, code, custIds[i % custIds.length], barberId, serviceId, startsAt, endsAt, price, status, customers[i % customers.length][0], customers[i % customers.length][1], iso(new Date(Date.parse(startsAt) - 2 * 3600_000)), nowIso()).run();
      const bookingId = ins.meta.last_row_id as number;
      const slotStmts = [];
      for (let t = Date.parse(startsAt); t < Date.parse(endsAt); t += 5 * 60000) {
        const key = new Date(t).toISOString().slice(0, 16).replace("T", " ");
        slotStmts.push(db.prepare(`INSERT OR IGNORE INTO booking_slots (company_id, booking_id, barber_id, slot) VALUES (?1,?2,?3,?4)`).bind(companyId, bookingId, barberId, key));
      }
      await db.batch(slotStmts);
      created.push({ id: bookingId, starts_at: startsAt, code, barber_id: barberId, status });
    } catch {
      /* colisão de slot na demo: pula este item */
    }
  }
  return created;
}

async function seedMessages(db: D1Database, companyId: number, bookings: { id: number; starts_at: string; code: string; barber_id: number; status: string }[]) {
  const now = Date.now();
  let n = 0;
  for (const b of bookings) {
    if (!["confirmado", "concluido", "pendente"].includes(b.status)) continue;
    n++;
    const sentAt = new Date(now - (2 + n) * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
    const price = 10, cost = 5;
    const ins = await db.prepare(`INSERT INTO message_jobs (company_id, kind, booking_id, to_phone, template_code, language, payload_json, status, scheduled_at, fire_deadline, price_cents, cost_cents, capture_on, reserved_cents, provider, provider_msg_id, sent_at, delivered_at, captured_at, demo, idempotency_key, created_at, updated_at)
      VALUES (?1,'reminder',?2,'5500000000009','tigu_lembrete','pt_BR','{}','delivered',?3,?3,?4,?5,'sent',0,'mock',?6,?3,?3,?3,1,?7,?3,?3)`)
      .bind(companyId, b.id, sentAt, price, cost, `mock-${1000 + n}`, `booking-${b.id}-reminder-v1-seed`).run();
    const jobId = ins.meta.last_row_id as number;
    // ref_id em wallet_transactions é TEXT ('job-N')
    await db.batch([
      db.prepare(`UPDATE message_jobs SET reservation_key=?1, last_error='' WHERE id=?2`).bind(`reserve:job-${jobId}`, jobId),
      db.prepare(`INSERT OR IGNORE INTO wallet_transactions (company_id, type, amount_cents, balance_after, reserved_after, ref_type, ref_id, idempotency_key, note, created_at) SELECT ?1,'capture',-?2, w.balance_cents, w.reserved_cents, 'message_job', 'job-'||?3, 'capture:job-'||?3, 'Mensagem de demonstração (cobrança fictícia)', ?4 FROM wallets w WHERE w.company_id=?1`).bind(companyId, price, jobId, sentAt),
    ]);
    void price;
  }
  return n;
}

async function seedWalletHistory(db: D1Database, companyId: number, spec: DemoCompanySpec) {
  const now = nowIso();
  const recharge = spec.plan === "free" ? 2000 : spec.plan === "pro" ? 5000 : 20000;
  // recarga inicial (topup 'paga') — sem gateway: criação direta marcada demo
  const insT = await db.prepare(`INSERT INTO topup_orders (company_id, code, amount_cents, status, provider, qr_code_text, paid_at, credited_at, demo, created_at, updated_at) VALUES (?1,?2,?3,'paid','mock',?4,?5,?5,1,?5,?5)`)
    .bind(companyId, `RGA-${spec.slug.slice(0, 4).toUpperCase()}DEMO`, recharge, `demo-pix-${companyId}`, now).run();
  const topupId = insT.meta.last_row_id as number;
  await db.batch([
    db.prepare(`UPDATE wallets SET balance_cents = balance_cents + ?1, lifetime_recharged_cents = lifetime_recharged_cents + ?1, updated_at=?2 WHERE company_id=?3`).bind(recharge, now, companyId),
    db.prepare(`INSERT INTO wallet_transactions (company_id, type, amount_cents, balance_after, reserved_after, ref_type, ref_id, idempotency_key, note, created_at) SELECT ?1,'topup',?2, w.balance_cents, w.reserved_cents,'topup_order',?3, 'topup:'||?3, 'Recarga fictícia de demonstração', ?4 FROM wallets w WHERE w.company_id=?1`).bind(companyId, recharge, String(topupId), now),
  ]);
}

/** Remove TUDO que tem demo=1 (e empresas demo em cascata). */
export async function purgeDemo(db: D1Database): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM message_webhook_events WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM message_attempts WHERE job_id IN (SELECT id FROM message_jobs WHERE company_id IN (SELECT id FROM companies WHERE demo=1))`),
    db.prepare(`DELETE FROM message_jobs WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM wallet_transactions WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM stock_movements WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE company_id IN (SELECT id FROM companies WHERE demo=1))`),
    db.prepare(`DELETE FROM orders WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM reviews WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM block_requests WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM blocked_days WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM booking_slots WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM bookings WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM customers WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM service_barbers WHERE service_id IN (SELECT id FROM services WHERE company_id IN (SELECT id FROM companies WHERE demo=1))`),
    db.prepare(`DELETE FROM services WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM products WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM barbers WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM whatsapp_templates WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM whatsapp_connections WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM notifications WHERE company_id IN (SELECT id FROM companies WHERE demo=1) OR demo=1`),
    db.prepare(`DELETE FROM topup_orders WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM wallets WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM subscriptions WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM company_memberships WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM company_settings WHERE company_id IN (SELECT id FROM companies WHERE demo=1)`),
    db.prepare(`DELETE FROM users WHERE demo=1`),
    db.prepare(`DELETE FROM companies WHERE demo=1`),
    db.prepare(`DELETE FROM sessions WHERE user_id NOT IN (SELECT id FROM users)`),
    db.prepare(`DELETE FROM audit_log WHERE company_id IN (SELECT id FROM companies WHERE 1=0) OR (user_name LIKE '%demo%' AND 1=0)`),
  ]);
}

/** Semeia dados fictícios para UMA empresa real (onboarding assistido pelo super). */
export async function seedDemoForCompany(db: D1Database, companyId: number): Promise<{ ok: boolean; created: number }> {
  const co = await db.prepare(`SELECT id, name, slug FROM companies WHERE id = ?1`).bind(companyId).first<{ id: number; name: string; slug: string }>();
  if (!co) return { ok: false, created: 0 };
  await db.prepare(`UPDATE companies SET demo = 1, updated_at = ?2 WHERE id = ?1`).bind(companyId, nowIso()).run(); // empresa passa a ser demo oficial (apagável em cascata)
  const spec: DemoCompanySpec = { slug: co.slug, name: co.name, plan: "pro", tagline: "Demo de catálogo", brand: DEFAULT_SETTINGS.brand, owner_email: "" };
  // cria catálogo demo; donos/usuários NÃO são criados aqui (a empresa já existe)
  const barberHash = await hashPassword(`Demo!${Math.random().toString(36).slice(2, 10)}`);
  const now = nowIso();
  const barberIds: number[] = [];
  for (const [i, name] of ["Profissional A (demo)", "Profissional B (demo)"].entries()) {
    const ins = await db.prepare(`INSERT INTO barbers (company_id, slug, name, specialty, work_days, active, sort, demo, created_at) VALUES (?1,?2,?3,'Demo','[1,2,3,4,5,6]',1,?4,1,?5)`).bind(companyId, `demo-prof-${i + 1}-${Date.now().toString(36)}`, name, i, now).run();
    barberIds.push(ins.meta.last_row_id as number);
  }
  const serviceIds: number[] = [];
  for (const [name, price, dur] of [["Corte demo", 4000, 45], ["Barba demo", 3000, 30]] as const) {
    const ins = await db.prepare(`INSERT INTO services (company_id, slug, name, description, price_cents, duration_min, active, show_in_catalog, demo, created_at) VALUES (?1,?2,?3,'Item de demonstração',?4,?5,1,1,1,?6)`).bind(companyId, `demo-svc-${Date.now().toString(36)}-${serviceIds.length}`, name, price, dur, now).run();
    serviceIds.push(ins.meta.last_row_id as number);
    for (const bid of barberIds) await db.prepare(`INSERT OR IGNORE INTO service_barbers (service_id, barber_id) VALUES (?1,?2)`).bind(ins.meta.last_row_id, bid).run();
  }
  await db.prepare(`INSERT OR IGNORE INTO wallets (company_id, updated_at) VALUES (?1,?2)`).bind(companyId, now).run();
  void barberHash; void spec;
  return { ok: true, created: barberIds.length + serviceIds.length };
}
