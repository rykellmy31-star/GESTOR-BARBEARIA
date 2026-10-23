// ============================================================================
// SUÍTE TIGU (/api/super/*) — operação da plataforma. Acesso: somente
// platform_role='superadmin'. Tudo que movimenta dinheiro exige justificativa,
// é idempotente e cai no audit_log (scope='platform').
// ============================================================================
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { err, json, nowIso, uniqueSlug, slugify } from "../lib/utils";
import { requireSuper } from "../lib/auth";
import { audit } from "../lib/audit";
import { hashPassword } from "../lib/crypto";
import { ensureWallet, getWallet, manualAdjustment, resolveUncertainNotSent } from "../lib/wallet";
import { confirmTopupFromProvider } from "../lib/topup";
import { loadPlatformSettings, setPlatformSetting, platformSettingKeys, type PlatformKey } from "../lib/settings";
import { isValidPlatformSetting } from "../lib/platform-setting-validation";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { loadSalesContact, saveSalesContact, salesContactSchema } from "../lib/marketing";
import { changePlan, listPublicPlans, planCodeSchema, planEditSchema } from "../lib/plans";
import { leadUpdateSchema, listSalesLeads, updateSalesLead, salesRetentionSchema, getSalesRetentionDays, setSalesRetentionDays, deleteSalesLead, purgeExpiredSalesLeads, purgeOldSalesRateLimits } from "../lib/sales-leads";
import { processDueJobs } from "../lib/messaging/jobs";
import { globalMessageListFilter, parseGlobalMessageCursor, parseOptionalMessageCompanyId } from "../lib/messaging/super-message-filter";
import { randomHex } from "../lib/utils";

export const superRouter = new Hono<{ Bindings: Env }>();
superRouter.use("*", requireSuper);

const idParam = (c: { req: { param: (k: string) => string | undefined } }) => parseInt(c.req.param("id") || "0", 10);
/** Apenas para rotas /wallets/:companyId, nunca confundir com parâmetro :id. */
const companyIdParam = (c: { req: { param: (k: string) => string | undefined } }): number | null => {
  const value = c.req.param("companyId");
  if (!value || !/^[1-9]\d*$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
};

// ── visão geral (KPIs financeiros da plataforma) ────────────────────────────
superRouter.get("/overview", async (c) => {
  const db = c.env.DB;
  const range = Math.min(365, Math.max(7, parseInt(c.req.query("days") || "30", 10)));
  const fromIso = new Date(Date.now() - range * 86400_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  const [counts, finance, usage, topups] = await Promise.all([
    db.prepare(`SELECT
        (SELECT COUNT(*) FROM companies WHERE status='active') AS active,
        (SELECT COUNT(*) FROM companies WHERE status='suspended') AS suspended,
        (SELECT COUNT(*) FROM companies WHERE created_at >= ?1) AS created_period,
        (SELECT COUNT(*) FROM users WHERE platform_role='user' AND active=1) AS users,
        (SELECT COUNT(*) FROM message_jobs WHERE status IN ('sent','delivered','read')) AS msgs_total`)
      .bind(fromIso).first(),
    db.prepare(`SELECT
        COALESCE(SUM(CASE WHEN wtx.type='topup' THEN wtx.amount_cents END),0) AS recharge_cents,
        COALESCE(SUM(CASE WHEN wtx.type='capture' THEN -wtx.amount_cents END),0) AS consumption_cents,
        COALESCE(SUM(CASE WHEN wtx.type='refund' THEN wtx.amount_cents END),0) AS refund_cents,
        COALESCE((SELECT SUM(cost_cents) FROM message_jobs WHERE captured_at IS NOT NULL AND captured_at>=?1),0) AS provider_cost_cents,
        COALESCE((SELECT SUM(balance_cents - reserved_cents) FROM wallets),0) AS float_held_cents
        FROM wallet_transactions wtx WHERE wtx.created_at >= ?1`).bind(fromIso).first(),
    db.prepare(`SELECT date(captured_at) AS day, COUNT(*) AS msgs, SUM(price_cents) AS revenue_cents, SUM(cost_cents) AS cost_cents
        FROM message_jobs WHERE captured_at IS NOT NULL AND captured_at >= ?1 GROUP BY day ORDER BY day DESC LIMIT 60`).bind(fromIso).all(),
    db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(amount_cents),0) cents FROM topup_orders WHERE status='paid' AND paid_at >= ?1`).bind(fromIso).first(),
  ]);
  const consumption = Number(finance?.consumption_cents ?? 0);
  const cost = Number(finance?.provider_cost_cents ?? 0);
  return json(c, {
    days: range,
    counts,
    finance: {
      ...finance,
      gross_margin_cents: consumption - cost,
      margin_pct: consumption > 0 ? Math.round(((consumption - cost) / consumption) * 1000) / 10 : 0,
    },
    usage_by_day: usage.results,
    topups,
    note_revenue: "A receita dos planos não entra neste quadro. Consulte Mensalidades Pix para acompanhar cobranças e confirmações de pagamento.",
  });
});

// ── empresas ─────────────────────────────────────────────────────────────────
superRouter.get("/companies", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const where = q ? `AND (c.name LIKE ?1 OR c.slug LIKE ?1)` : "";
  const p = q ? [`%${q}%`] : [];
  const { results } = await c.env.DB
    .prepare(
      `SELECT c.id, c.slug, c.name, c.status, c.suspend_reason, c.demo, c.created_at,
              s.plan_code, s.status AS sub_status, s.period_end,
              COALESCE(w.balance_cents,0) AS balance_cents, COALESCE(w.reserved_cents,0) AS reserved_cents,
              (SELECT COUNT(*) FROM message_jobs j WHERE j.company_id=c.id AND j.captured_at>=strftime('%Y-%m-%dT00:00:00Z', date('now','start of month'))) AS msgs_this_month,
              (SELECT COUNT(*) FROM bookings b WHERE b.company_id=c.id AND b.status IN ('pendente','confirmado')) AS upcoming,
              (SELECT COUNT(*) FROM company_memberships m WHERE m.company_id=c.id AND m.active=1) AS members
       FROM companies c
       LEFT JOIN subscriptions s ON s.company_id=c.id
       LEFT JOIN wallets w ON w.company_id=c.id
       WHERE 1=1 ${where} ORDER BY c.id DESC LIMIT 200`
    )
    .bind(...p)
    .all();
  return json(c, { companies: results });
});

superRouter.get("/companies/:id", async (c) => {
  const db = c.env.DB;
  const id = idParam(c);
  const co = await db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM bookings b WHERE b.company_id=c.id) AS bookings_total FROM companies c WHERE c.id=?1`).bind(id).first();
  if (!co) return err(c, "Empresa não encontrada", 404);
  const [settings, members, conn, wallet, jobs, subscription] = await Promise.all([
    db.prepare(`SELECT data FROM company_settings WHERE company_id=?1`).bind(id).first<{ data: string }>(),
    db.prepare(`SELECT m.id, m.role, m.active, u.id AS user_id, u.name, u.email, u.last_login_at FROM company_memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=?1`).bind(id).all(),
    db.prepare(`SELECT provider, status, display_phone, business_name, waba_id, phone_number_id, coexistence, last_error, last_check_at FROM whatsapp_connections WHERE company_id=?1`).bind(id).first(),
    getWallet(db, id),
    db.prepare(`SELECT id, kind, status, price_cents, cost_cents, captured_at, refunded_at, created_at FROM message_jobs WHERE company_id=?1 ORDER BY id DESC LIMIT 25`).bind(id).all(),
    db.prepare("SELECT plan_code,status,started_at,period_end FROM subscriptions WHERE company_id=?1").bind(id).first(),
  ]);
  c.header("Cache-Control", "no-store");
  return json(c, { company: co, subscription, settings: safeParse(settings?.data), members: members.results, connection: conn ?? null, wallet, jobs: jobs.results });
});
/** O Super Admin pode emitir uma nova senha de acesso do proprietário.
 * Nunca recupera hashes, nem altera contas vinculadas a múltiplas empresas
 * sem um processo dedicado para evitar derrubar sessões de outros tenants.
 * O segredo é retornado uma única vez, apenas na resposta autenticada. */
superRouter.post("/companies/:id/owners/:userId/reset-access", async (c) => {
  const id = idParam(c);
  const idText=c.req.param("id") || "";
  const userText=c.req.param("userId") || "";
  if(!/^[1-9]\d*$/.test(idText) || !/^[1-9]\d*$/.test(userText))
    return err(c,"Identificador inválido",400);
  const userId=Number(userText);
  if(!Number.isSafeInteger(id)||!Number.isSafeInteger(userId))
    return err(c,"Identificador inválido",400);
  const db=c.env.DB;
  const membership=await db.prepare(`
    SELECT u.id,u.platform_role,u.active, m.active AS membership_active
    FROM company_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.company_id=?1 AND m.user_id=?2 AND m.role='owner'
  `).bind(id,userId).first<{id:number;platform_role:string;active:number;membership_active:number}>();
  if(!membership || membership.platform_role!=="user" ||
     membership.active!==1 || membership.membership_active!==1)
    return err(c,"Selecione um proprietário ativo desta barbearia.",403);
  const linked=await db.prepare(
    "SELECT COUNT(DISTINCT company_id) AS n FROM company_memberships WHERE user_id=?1"
  ).bind(userId).first<{n:number}>();
  if(Number(linked?.n)!==1)
    return err(c,"Esta conta está vinculada a outras barbearias. Redefinição global bloqueada para proteger outros acessos.",409);
  const temporaryPassword=`Tigu!${randomHex(18)}`;
  const hash=await hashPassword(temporaryPassword);
  const updated=await db.batch([
    db.prepare(`UPDATE users SET password_hash=?1,must_change_password=1
      WHERE id=?2 AND active=1 AND platform_role='user'
        AND EXISTS (SELECT 1 FROM company_memberships
          WHERE company_id=?3 AND user_id=?2 AND role='owner' AND active=1)
        AND (SELECT COUNT(DISTINCT company_id) FROM company_memberships WHERE user_id=?2)=1`)
      .bind(hash,userId,id),
    db.prepare("DELETE FROM sessions WHERE user_id=?1").bind(userId),
    db.prepare("UPDATE password_resets SET used_at=?1 WHERE user_id=?2 AND used_at IS NULL")
      .bind(nowIso(),userId),
  ]);
  if(Number(updated[0].meta?.changes)!==1)
    return err(c,"A conta foi modificada; nenhuma nova senha pode ser confirmada.",409);
  try {
    await audit(db,c.get("user"),"company.owner_password_reset","user",userId,
      {owner_id:userId,revoked_sessions:true,requires_password_change:true},
      {companyId:id,scope:"platform"});
  } catch {
    console.error("[super] Falha de auditoria de redefinição de senha, ação concluída");
  }
  c.header("Cache-Control","no-store, private");
  c.header("Pragma","no-cache");
  c.header("Referrer-Policy","no-referrer");
  return json(c,{ok:true,generated_password:temporaryPassword,requires_password_change:true});
});

function safeParse(v?: string) { try { return v ? JSON.parse(v) : DEFAULT_SETTINGS; } catch { return DEFAULT_SETTINGS; } }

const createCompanySchema = z.object({
  name: z.string().min(3).max(80),
  slug: z.string().regex(/^[a-z0-9-]{3,80}$/).optional(),
  plan_code: z.enum(["free", "pro", "scale"]).default("pro"),
  owner_email: z.string().email(),
  owner_name: z.string().min(2).max(90),
  owner_password: z.string().min(10).max(128).optional(),
});
superRouter.post("/companies", async (c) => {
  const parsed = createCompanySchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 422, parsed.error.flatten().fieldErrors);
  const db=c.env.DB,d=parsed.data,ownerEmail=d.owner_email.trim().toLowerCase();
  const owner=await db.prepare("SELECT id,active FROM users WHERE email=?1").bind(ownerEmail).first<{id:number;active:number}>();
  if (owner && !owner.active) return err(c,"A conta do dono está desativada. Revise o acesso antes de cadastrar a empresa.",409);
  const plan=await db.prepare("SELECT code FROM plans WHERE code=?1 AND demo=0").bind(d.plan_code).first();
  if (!plan) return err(c,"Plano indisponível",422);
  const createdUser=!owner,generatedPassword=createdUser&&!d.owner_password?`Tigu!${randomHex(16)}`:undefined;
  const passwordHash=createdUser?await hashPassword(d.owner_password||generatedPassword!):null;
  const slug=await uniqueSlug(db,"companies",d.slug||slugify(d.name));
  const at=nowIso(),trialEnd=new Date(Date.parse(at)+15*86400000).toISOString().replace(/\.\d{3}Z$/,"Z");
  const statements:D1PreparedStatement[]=[];
  if (createdUser) statements.push(db.prepare("INSERT INTO users(platform_role,name,email,password_hash,active,must_change_password,created_at) VALUES ('user',?1,?2,?3,1,1,?4)").bind(d.owner_name.trim(),ownerEmail,passwordHash,at));
  const companyIndex=statements.length;
  statements.push(
    db.prepare("INSERT INTO companies(slug,name,status,plan_code,created_at,updated_at) VALUES (?1,?2,'active',?3,?4,?4)").bind(slug,d.name.trim(),d.plan_code,at),
    db.prepare("INSERT INTO company_settings(company_id,data,updated_at) SELECT id,?2,?3 FROM companies WHERE slug=?1").bind(slug,JSON.stringify({...DEFAULT_SETTINGS,shop_name:d.name.trim()}),at),
    db.prepare(`INSERT INTO company_memberships(company_id,user_id,role,active,created_at)
      SELECT c.id,u.id,'owner',1,?3 FROM companies c JOIN users u ON u.email=?2 WHERE c.slug=?1`)
      .bind(slug,ownerEmail,at),
    db.prepare(`INSERT INTO subscriptions(company_id,plan_code,status,started_at,period_end,updated_at)
      SELECT id,?2,'trial',?3,?4,?3 FROM companies WHERE slug=?1`).bind(slug,d.plan_code,at,trialEnd),
    db.prepare("INSERT INTO wallets(company_id,updated_at) SELECT id,?2 FROM companies WHERE slug=?1").bind(slug,at),
    db.prepare(`INSERT INTO notifications(company_id,audience,title,body,kind)
      SELECT id,'admin','Bem-vindo à Tigu!','Seu teste gratuito dura 15 dias. Complete o catálogo e a equipe.','system' FROM companies WHERE slug=?1`).bind(slug),
  );
  let companyId:number,userId:number;
  try {
    const results=await db.batch(statements);
    companyId=Number(results[companyIndex].meta.last_row_id);
    userId=owner?.id??Number(results[0].meta.last_row_id);
  } catch {
    return err(c,"Não foi possível concluir o cadastro. Nenhuma empresa parcial foi criada. Atualize e tente novamente.",503);
  }
  try {
    await audit(db,c.get("user"),"company.create","company",companyId,{slug,plan:d.plan_code,owner_email:ownerEmail,trial_end:trialEnd},{companyId,scope:"platform"});
  } catch { console.error("[company.create] Falha de auditoria após cadastro concluído"); }
  c.header("Cache-Control","no-store");
  return json(c,{ok:true,id:companyId,slug,owner_user_id:userId,created_user:createdUser,
    generated_password:generatedPassword,trial_end:trialEnd,trial_started_at:at,
    trial_days:15,company_name:d.name.trim(),plan_code:d.plan_code,owner_name:d.owner_name.trim()},201);
});

superRouter.post("/companies/:id/suspend", async (c) => {
  const parsed = z.object({ reason: z.string().min(5).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Justificativa obrigatória (5+ chars)", 400);
  const db = c.env.DB; const id = idParam(c);
  await db.batch([
    db.prepare(`UPDATE companies SET status='suspended', suspend_reason=?1, updated_at=?2 WHERE id=?3`).bind(parsed.data.reason.trim(), nowIso(), id),
    db.prepare(`INSERT INTO notifications (company_id, audience, title, body, kind) VALUES (?1,'admin','Sua barbearia foi suspensa',?2,'system')`).bind(id, parsed.data.reason.trim()),
  ]);
  await audit(db, c.get("user"), "company.suspend", "company", id, { reason: parsed.data.reason }, { companyId: id, scope: "platform" });
  return json(c, { ok: true });
});
superRouter.post("/companies/:id/resume", async (c) => {
  const db = c.env.DB; const id = idParam(c);
  await db.batch([
    db.prepare(`UPDATE companies SET status='active', suspend_reason='', updated_at=?1 WHERE id=?2`).bind(nowIso(), id),
    db.prepare(`INSERT INTO notifications (company_id, audience, title, body, kind) VALUES (?1,'admin','Acesso restabelecido','Sua barbearia voltou a operar na Tigu.','system')`).bind(id),
  ]);
  await audit(db, c.get("user"), "company.resume", "company", id, {}, { companyId: id, scope: "platform" });
  return json(c, { ok: true });
});
superRouter.put("/companies/:id/plan", async (c) => {
  const parsed = z.object({ plan_code: z.enum(["free", "pro", "scale"]), note: z.string().max(200).default("") }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "plano inválido", 400);
  const db = c.env.DB; const id = idParam(c);
  await db.batch([
    db.prepare(`UPDATE subscriptions SET plan_code=?1,status='active',period_end=strftime('%Y-%m-%dT%H:%M:%SZ',?2,'+1 month'),updated_at=?2 WHERE company_id=?3`).bind(parsed.data.plan_code, nowIso(), id),
    db.prepare(`UPDATE companies SET plan_code=?1, updated_at=?2 WHERE id=?3`).bind(parsed.data.plan_code, nowIso(), id),
    db.prepare(`INSERT INTO notifications (company_id, audience, title, body, kind) VALUES (?1,'admin',?2,?3,'system')`).bind(id, `Plano alterado para ${parsed.data.plan_code.toUpperCase()}`, parsed.data.note || "Ajustado pela equipe Tigu."),
  ]);
  await audit(db, c.get("user"), "company.plan", "company", id, { plan: parsed.data.plan_code, note: parsed.data.note }, { companyId: id, scope: "platform" });
  return json(c, { ok: true });
});
superRouter.post("/companies/:id/seed-demo", async (c) => {
  // onboarding assistido: dados fictícios marcados demo=1 (apagáveis)
  const { seedDemoForCompany } = await import("../lib/demo-seed");
  const id = idParam(c);
  const out = await seedDemoForCompany(c.env.DB, id);
  await audit(c.env.DB, c.get("user"), "company.seed_demo", "company", id, out, { companyId: id, scope: "platform" });
  return json(c, { ...out });
});

// ── usuários & memberships ───────────────────────────────────────────────────
superRouter.get("/users", async (c) => {
  const q = (c.req.query("q") || "").trim();
  const where = q ? `AND (u.name LIKE ?1 OR u.email LIKE ?1)` : "";
  const { results } = await c.env.DB
    .prepare(`SELECT u.id, u.name, u.email, u.platform_role, u.active, u.must_change_password, u.last_login_at, u.created_at,
                      COALESCE(GROUP_CONCAT(DISTINCT c.slug), '') AS companies,
                      COALESCE(GROUP_CONCAT(DISTINCT m.role), '') AS membership_roles
               FROM users u LEFT JOIN company_memberships m ON m.user_id=u.id AND m.active=1 LEFT JOIN companies c ON c.id=m.company_id
               WHERE 1=1 ${where} GROUP BY u.id ORDER BY u.id DESC LIMIT 200`)
    .bind(...(q ? [`%${q}%`] : []))
    .all();
  return json(c, { users: results });
});
superRouter.put("/users/:id", async (c) => {
  const parsed = z.object({ active: z.boolean().optional(), platform_role: z.enum(["user", "superadmin"]).optional(), reset_password: z.string().min(10).max(128).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 400);
  const db = c.env.DB; const id = idParam(c);
  const u = await db.prepare(`SELECT id, platform_role FROM users WHERE id=?1`).bind(id).first<{ id: number; platform_role: string }>();
  if (!u) return err(c, "Usuário não encontrado", 404);
  const d = parsed.data;
  const updates:D1PreparedStatement[]=[];
  if (typeof d.active === "boolean") updates.push(db.prepare("UPDATE users SET active=?1 WHERE id=?2").bind(d.active?1:0,id));
  if (d.platform_role) updates.push(db.prepare("UPDATE users SET platform_role=?1 WHERE id=?2").bind(d.platform_role,id));
  if (d.reset_password) updates.push(db.prepare("UPDATE users SET password_hash=?1,must_change_password=1 WHERE id=?2").bind(await hashPassword(d.reset_password),id));
  if (d.reset_password||d.active===false||d.platform_role) updates.push(
    db.prepare("DELETE FROM sessions WHERE user_id=?1").bind(id),
    db.prepare("UPDATE password_resets SET used_at=?1 WHERE user_id=?2 AND used_at IS NULL").bind(nowIso(),id),
  );
  try {
    if (updates.length) await db.batch(updates);
  } catch (error) {
    if (String(error).includes("TIGU_LAST_SUPERADMIN")) return err(c, "Mantenha ao menos um Superadmin ativo. Cadastre ou reative outro antes de remover este acesso.", 409);
    throw error;
  }
  await audit(db, c.get("user"), "user.update", "user", id, { active: d.active, role: d.platform_role, reset: Boolean(d.reset_password) }, { companyId: null, scope: "platform" });
  return json(c, { ok: true });
});
const memberSchema = z.object({ company_id: z.number().int().positive(), user_id: z.number().int().positive().optional(), email: z.string().trim().email().optional(), role: z.enum(["owner", "manager", "barber"]), barber_id: z.number().int().positive().nullable().default(null) });
superRouter.post("/memberships", async (c) => {
  const parsed = memberSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 400);
  const d = parsed.data;
  const db = c.env.DB;
  const co = await db.prepare(`SELECT id FROM companies WHERE id=?1`).bind(d.company_id).first();
  if (!co) return err(c, "Empresa inválida", 404);
  let uid = d.user_id ?? 0;
  if (!uid && d.email) uid = (await db.prepare(`SELECT id FROM users WHERE email=?1`).bind(d.email.toLowerCase()).first<{ id: number }>())?.id ?? 0;
  if (!uid) return err(c, "Informe user_id ou e-mail cadastrado", 400);
  const target = await db.prepare("SELECT active FROM users WHERE id=?1").bind(uid).first<{active:number}>();
  if (!target) return err(c, "Usuário não encontrado", 404);
  if (!target.active) return err(c, "Reative a conta antes de conceder acesso à empresa", 409);
  if (d.role === "barber" && !d.barber_id) return err(c, "Selecione o profissional da empresa para este acesso", 422);
  if (d.barber_id && !await db.prepare("SELECT id FROM barbers WHERE id=?1 AND company_id=?2 AND active=1").bind(d.barber_id,d.company_id).first())
    return err(c, "Profissional inválido ou inativo para esta empresa", 422);
  const barberId = d.role === "barber" ? d.barber_id : null;
  // Revalida as referências no próprio write para não conceder acesso com dados obsoletos.
  const saved = await db.prepare(`INSERT INTO company_memberships (company_id, user_id, role, barber_id, active, created_at)
    SELECT c.id,u.id,?3,?4,1,?5 FROM companies c JOIN users u ON u.id=?2 AND u.active=1
    WHERE c.id=?1 AND (?4 IS NULL OR EXISTS(SELECT 1 FROM barbers b WHERE b.id=?4 AND b.company_id=c.id AND b.active=1))
    ON CONFLICT(company_id, user_id) DO UPDATE SET role=excluded.role,barber_id=excluded.barber_id,active=1`)
    .bind(d.company_id,uid,d.role,barberId,nowIso()).run();
  if (saved.meta.changes !== 1) return err(c, "Os dados do acesso mudaram. Atualize a página e tente novamente.", 409);
  await audit(db, c.get("user"), "membership.set", "company_membership", `${d.company_id}:${uid}`, { role: d.role }, { companyId: d.company_id, scope: "platform" });
  return json(c, { ok: true });
});
superRouter.delete("/memberships/:id", async (c) => {
  await c.env.DB.prepare(`UPDATE company_memberships SET active=0 WHERE id=?1`).bind(idParam(c)).run();
  await audit(c.env.DB, c.get("user"), "membership.revoke", "company_membership", idParam(c), {}, { companyId: null, scope: "platform" });
  return json(c, { ok: true });
});

// ── carteira: ajustes, consultas ────────────────────────────────────────────
superRouter.get("/wallets/:companyId", async (c) => {
  const id = companyIdParam(c);
  if (id === null) return err(c, "Identificador da empresa inválido", 400);
  const wallet = await getWallet(c.env.DB, id);
  if (!wallet) return err(c, "Carteira não encontrada", 404);
  const { results } = await c.env.DB.prepare(`SELECT * FROM wallet_transactions WHERE company_id=?1 ORDER BY id DESC LIMIT 100`).bind(id).all();
  return json(c, { wallet, transactions: results });
});
superRouter.post("/wallets/:companyId/adjust", async (c) => {
  const parsed = z.object({ delta_cents: z.number().int(), justification: z.string().min(10).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "delta_cents + justificativa (10+ chars)", 400);
  const db = c.env.DB; const id = companyIdParam(c);
  if (id === null) return err(c, "Identificador da empresa inválido", 400);
  const co = await db.prepare(`SELECT id FROM companies WHERE id=?1`).bind(id).first();
  if (!co) return err(c, "Empresa inválida", 404);
  await ensureWallet(db, id);
  const key = randomHex(12); // cada operação é um evento único (idempotência por request)
  const res = await manualAdjustment(db, id, parsed.data.delta_cents, parsed.data.justification, (c.get("user") as { id: number }).id, key);
  if (!res.ok) return err(c, res.error ?? "Ajuste falhou", 409);
  await db.prepare(`INSERT INTO notifications (company_id, audience, title, body, kind) VALUES (?1,'admin',?2,?3,'billing')`).bind(id, parsed.data.delta_cents >= 0 ? "Crédito adicionado pela equipe Tigu" : "Ajuste de créditos", `${(parsed.data.delta_cents / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" })} — ${parsed.data.justification.trim()}`).run();
  await audit(db, c.get("user"), "wallet.adjust", "wallet", id, { delta_cents: parsed.data.delta_cents, justification: parsed.data.justification, key }, { companyId: id, scope: "platform" });
  return json(c, { ok: true });
});
superRouter.put("/wallets/:companyId/policy", async (c) => {
  const parsed = z.object({ allow_negative: z.boolean(), low_balance_alert_cents: z.number().int().min(0).max(100000).optional() }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 400);
  const id = companyIdParam(c);
  if (id === null) return err(c, "Identificador da empresa inválido", 400);
  const exists = await c.env.DB.prepare("SELECT id FROM companies WHERE id=?1").bind(id).first();
  if (!exists) return err(c, "Empresa inválida", 404);
  await ensureWallet(c.env.DB, id);
  await c.env.DB.prepare(`UPDATE wallets SET allow_negative=?1, low_balance_alert_cents=COALESCE(?2, low_balance_alert_cents), updated_at=?3 WHERE company_id=?4`)
    .bind(parsed.data.allow_negative ? 1 : 0, parsed.data.low_balance_alert_cents ?? null, nowIso(), id).run();
  await audit(c.env.DB, c.get("user"), "wallet.policy", "wallet", id, parsed.data, { companyId: id, scope: "platform" });
  return json(c, { ok: true, warning: "Permitir saldo negativo autoriza cobrança além do saldo — use só para clientes com contrato firme." });
});

// ── pagamentos / recargas / reembolsos ──────────────────────────────────────
// ── mensalidades Pix dos planos — acompanhamento, sem liberação manual ──────
superRouter.get("/subscription-invoices", async (c) => {
  const status = c.req.query("status") || "";
  const query = (c.req.query("q") || "").trim().slice(0, 80);
  const allowed = ["", "creating", "pending", "paid", "expired", "failed"];
  if (!allowed.includes(status)) return err(c, "Situação de fatura inválida.", 422);
  const db = c.env.DB;
  // Não retornar QR Code, token ou dados do titular ao dashboard global.
  const [list, totals] = await Promise.all([
    db.prepare(`SELECT i.id,i.code,i.company_id,c.name AS company_name,c.slug,
        i.plan_code,i.amount_cents,i.status,i.provider_payment_id,
        i.expires_at,i.paid_at,i.created_at,i.updated_at
      FROM subscription_invoices i JOIN companies c ON c.id=i.company_id
      WHERE (?1='' OR i.status=?1)
        AND (?2='' OR instr(lower(c.name),lower(?2))>0
          OR instr(lower(c.slug),lower(?2))>0
          OR instr(lower(i.code),lower(?2))>0)
      ORDER BY i.created_at DESC,i.id DESC LIMIT 100`)
      .bind(status,query).all(),
    db.prepare(`SELECT
      COUNT(*) AS total,
      COALESCE(SUM(CASE WHEN status='paid' THEN 1 ELSE 0 END),0) AS paid_count,
      COALESCE(SUM(CASE WHEN status='paid' THEN amount_cents ELSE 0 END),0) AS paid_cents,
      COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) AS pending_count,
      COALESCE(SUM(CASE WHEN status='creating' THEN 1 ELSE 0 END),0) AS creating_count,
      COALESCE(SUM(CASE WHEN status IN ('failed','expired') THEN 1 ELSE 0 END),0) AS closed_count
      FROM subscription_invoices`).first(),
  ]);
  return json(c, { invoices: list.results, summary: totals, limit: 100 });
});

superRouter.get("/topups", async (c) => {
  const status = c.req.query("status") || "";
  const { results } = await c.env.DB
    .prepare(`SELECT t.*, c.name AS company_name FROM topup_orders t JOIN companies c ON c.id=t.company_id ${status ? "WHERE t.status = ?1" : ""} ORDER BY t.id DESC LIMIT 200`)
    .bind(...(status ? [status] : []))
    .all();
  return json(c, { topups: results });
});
superRouter.post("/topups/:id/confirm", async (c) => {
  const parsed = z.object({ justification: z.string().min(10).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Justificativa obrigatória (10+ chars) para crédito manual", 400);
  const t = await c.env.DB.prepare(`SELECT * FROM topup_orders WHERE id=?1`).bind(idParam(c)).first<{ status: string; company_id: number; amount_cents: number; provider_payment_id: string | null; code: string }>();
  if (!t) return err(c, "Pedido não encontrado", 404);
  if (t.status === "paid") return json(c, { ok: true, credited: false, note: "já creditada (idempotente)" });
  const res = await confirmTopupFromProvider(c.env, t.provider_payment_id || t.code, "manual", parsed.data.justification.trim());
  if (!res.ok || !res.credited) return err(c, res.message ?? "Não foi possível creditar", 409);
  return json(c, { ok: true, credited: true });
});
superRouter.post("/jobs/:id/refund", async (c) => {
  const parsed = z.object({ justification: z.string().min(10).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Justificativa obrigatória", 400);
  const db = c.env.DB;
  const job = await db.prepare(`SELECT id, company_id, price_cents, captured_at, refunded_at FROM message_jobs WHERE id=?1`).bind(idParam(c)).first<{ id: number; company_id: number; price_cents: number; captured_at: string | null; refunded_at: string | null }>();
  if (!job) return err(c, "Job não encontrado", 404);
  if (!job.captured_at) return err(c, "Este envio não chegou a ser cobrado — nada a estornar", 409);
  if (job.refunded_at) return json(c, { ok: true, note: "já estornado (idempotente)" });
  const { refundJobCharge } = await import("../lib/wallet");
  const ok = await refundJobCharge(db, job.company_id, job.id, job.price_cents, `Estorno manual Tigu: ${parsed.data.justification.trim()}`, (c.get("user") as { id: number }).id);
  await audit(db, c.get("user"), "job.refund", "message_job", job.id, { justification: parsed.data.justification, cents: job.price_cents }, { companyId: job.company_id, scope: "platform" });
  return json(c, { ok });
});

// ── planos de contratação da plataforma (não efetua cobrança recorrente) ─────
superRouter.get("/plans", async (c) =>
  json(c, { plans: await listPublicPlans(c.env.DB), automatic_billing: false })
);

superRouter.put("/plans/:code", async (c) => {
  const code = planCodeSchema.safeParse(c.req.param("code"));
  const parsed = planEditSchema.safeParse(await c.req.json().catch(() => null));
  if (!code.success || !parsed.success) return err(c, "Plano ou configuração inválida.", 422);
  if (code.data === "free" && parsed.data.price_cents_month < 1)
    return err(c, "O Tigu Start é um plano pago após o teste grátis. Informe uma mensalidade válida.", 422);
  const previous = (await listPublicPlans(c.env.DB)).find(p => p.code === code.data);
  if (!previous) return err(c, "Plano inexistente.", 404);
  const result = await changePlan(c.env.DB, code.data, parsed.data);
  if (result.meta?.changes !== 1) return err(c, "Não foi possível atualizar o plano.", 409);
  await audit(c.env.DB, c.get("user"), "platform.plan_update", "plan", code.data,
    { before: previous, after: parsed.data, automatic_billing: false },
    { companyId: null, scope: "platform" });
  return json(c, { ok: true, plan: (await listPublicPlans(c.env.DB)).find(p => p.code === code.data) });
});

// ── interessados na contratação dos planos pagos — apenas Superadmin ─────
superRouter.get("/leads", async (c) => {
  const status = c.req.query("status") || "";
  const query = (c.req.query("q") || "").trim().slice(0, 80);
  if (status && !["new","contacted","negotiating","closed"].includes(status))
    return err(c, "Status inválido", 422);
  const cursor = c.req.query("beforeId");
  if (cursor !== undefined && (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))
    return err(c, "Cursor de interessados inválido.", 400);
  return json(c, await listSalesLeads(c.env.DB, status, query, cursor ? Number(cursor) : null));
});

superRouter.get("/leads/privacy", async (c) =>
  json(c, { retention_days: await getSalesRetentionDays(c.env.DB) })
);

superRouter.put("/leads/privacy", async (c) => {
  const parsed = salesRetentionSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Escolha um prazo de retenção permitido.", 422);
  const previous = await getSalesRetentionDays(c.env.DB);
  await setSalesRetentionDays(c.env.DB, parsed.data.days);
  await audit(c.env.DB, c.get("user"), "sales_leads.retention", "platform_settings", "sales_leads_retention_days",
    { from_days: previous, to_days: parsed.data.days }, { companyId: null, scope: "platform" });
  return json(c, { ok: true, retention_days: parsed.data.days });
});

/** Exclusão expressa de dados comerciais solicitada pelo titular ou operador. */
superRouter.delete("/leads/:id", async (c) => {
  const id = idParam(c);
  if (!Number.isSafeInteger(id) || id <= 0) return err(c, "Solicitação inválida.", 422);
  const payload = z.object({ reason: z.enum(["privacy_request","duplicate","no_longer_needed"]) })
    .strict().safeParse(await c.req.json().catch(() => null));
  if (!payload.success) return err(c, "Justificativa de exclusão inválida.", 422);
  if (!await deleteSalesLead(c.env.DB, id)) return err(c, "Solicitação não encontrada.", 404);
  await audit(c.env.DB, c.get("user"), "sales_lead.delete", "sales_lead", id,
    { reason: payload.data.reason }, { companyId: null, scope: "platform" });
  return json(c, { ok: true });
});

/** Ação manual, limitada a 200 contatos por execução; cron faz limpeza diária. */
superRouter.post("/leads/privacy/cleanup", async (c) => {
  const removed = await purgeExpiredSalesLeads(c.env.DB);
  const fingerprints = await purgeOldSalesRateLimits(c.env.DB);
  await audit(c.env.DB, c.get("user"), "sales_leads.cleanup", "sales_leads", "",
    { removed, old_fingerprints: fingerprints }, { companyId: null, scope: "platform" });
  return json(c, { ok: true, removed, old_fingerprints: fingerprints });
});

superRouter.patch("/leads/:id", async (c) => {
  const id = idParam(c);
  if (!Number.isSafeInteger(id) || id<=0) return err(c, "Solicitação inválida", 422);
  const parsed = leadUpdateSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Status ou observação inválidos.", 422);
  const previous = await c.env.DB.prepare(
    "SELECT status,internal_note FROM sales_leads WHERE id=?1"
  ).bind(id).first<{status:string;internal_note:string}>();
  if (!previous) return err(c, "Solicitação não encontrada.", 404);
  const updated = await updateSalesLead(c.env.DB, id, parsed.data);
  if (!updated) return err(c, "Solicitação alterada durante o atendimento.", 409);
  await audit(c.env.DB, c.get("user"), "sales_lead.update", "sales_lead", id,
    { previous_status:previous.status, status:parsed.data.status, note_changed:previous.internal_note!==parsed.data.internal_note },
    {companyId:null,scope:"platform"});
  return json(c, {ok:true});
});

// ── precificação (global e por empresa) ─────────────────────────────────────
superRouter.get("/pricing", async (c) => {
  const { results } = await c.env.DB.prepare(`SELECT pr.*, COALESCE(c.name,'(padrão global)') AS company_name FROM pricing_rules pr LEFT JOIN companies c ON c.id=pr.company_id WHERE pr.active=1 ORDER BY pr.company_id IS NOT NULL, pr.id`).all();
  const platform = await loadPlatformSettings(c.env.DB);
  return json(c, { rules: results, platform });
});
const pricingSchema = z.object({ company_id: z.number().int().positive().nullable().default(null), category: z.enum(["any", "utility", "marketing", "authentication"]), price_cents: z.number().int().min(0).max(100000), cost_cents: z.number().int().min(0).max(100000) });
superRouter.post("/pricing", async (c) => {
  const parsed = pricingSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados inválidos", 400);
  const d = parsed.data;
  const db = c.env.DB;
  if (d.company_id) {
    const co = await db.prepare(`SELECT id FROM companies WHERE id=?1`).bind(d.company_id).first();
    if (!co) return err(c, "Empresa inválida", 404);
  }
  // sobrescreve regra ativa da mesma (company, category) — histórico vai p/ audit
  const cur = await db.prepare(`SELECT id FROM pricing_rules WHERE COALESCE(company_id,0)=COALESCE(?1,0) AND category=?2 AND active=1`).bind(d.company_id, d.category).first<{ id: number }>();
  if (cur) await db.prepare(`UPDATE pricing_rules SET price_cents=?1, cost_cents=?2, updated_at=?3 WHERE id=?4`).bind(d.price_cents, d.cost_cents, nowIso(), cur.id).run();
  else await db.prepare(`INSERT INTO pricing_rules (company_id, category, price_cents, cost_cents, active, updated_at) VALUES (?1,?2,?3,?4,1,?5)`).bind(d.company_id, d.category, d.price_cents, d.cost_cents, nowIso()).run();
  await audit(db, c.get("user"), "pricing.set", "pricing_rule", cur?.id ?? "new", d, { companyId: d.company_id, scope: "platform" });
  return json(c, { ok: true, message: "Vigente para novos agendamentos (jobs já programados mantêm o preço congelado)." });
});
superRouter.delete("/pricing/:id", async (c) => {
  await c.env.DB.prepare(`UPDATE pricing_rules SET active=0, updated_at=?1 WHERE id=?2`).bind(nowIso(), idParam(c)).run();
  await audit(c.env.DB, c.get("user"), "pricing.disable", "pricing_rule", idParam(c), {}, { companyId: null, scope: "platform" });
  return json(c, { ok: true });
});

// ── configurações da plataforma ──────────────────────────────────────────────
superRouter.get("/settings", async (c) => json(c, { settings: await loadPlatformSettings(c.env.DB, 0), keys: platformSettingKeys }));
superRouter.put("/settings", async (c) => {
  const parsed = z.object({ key: z.enum(platformSettingKeys as unknown as [PlatformKey, ...PlatformKey[]]), value: z.union([z.number().int().min(0).max(100000000), z.enum(["sent", "delivered"])]) }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success || !isValidPlatformSetting(parsed.data.key, parsed.data.value))
    return err(c, "chave/valor inválidos", 422);
  const saved = await setPlatformSetting(c.env.DB, parsed.data.key, parsed.data.value);
  if (!saved) return err(c, "Configuração recusada: limites financeiros incompatíveis", 422);
  await audit(c.env.DB, c.get("user"), "platform.setting", "platform_settings", parsed.data.key, parsed.data, { companyId: null, scope: "platform" });
  return json(c, { ok: true });
});

// ── contato comercial da página de vendas (somente superadmin) ──────────────
superRouter.get("/marketing/contact", async (c) =>
  json(c, { contact: await loadSalesContact(c.env.DB) })
);

superRouter.put("/marketing/contact", async (c) => {
  const parsed = salesContactSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados de contato inválidos.", 422, parsed.error.flatten().fieldErrors);
  await saveSalesContact(c.env.DB, parsed.data);
  // Auditoria registra quais campos mudaram, sem copiar contatos para logs desnecessários.
  await audit(c.env.DB, c.get("user"), "platform.marketing_contact", "platform_settings", "sales_contact",
    { enabled: parsed.data.enabled, whatsapp_configured: Boolean(parsed.data.whatsapp), email_configured: Boolean(parsed.data.email) },
    { companyId: null, scope: "platform" }
  );
  return json(c, { ok: true, contact: parsed.data });
});

// ── fila de mensagens global (ops) ──────────────────────────────────────────
superRouter.get("/messages", async (c) => {
  const beforeId = parseGlobalMessageCursor(c.req.query("beforeId"));
  if (beforeId === undefined) return err(c, "Cursor de mensagem inválido", 400);
  const { where, binds } = globalMessageListFilter(c.req.query("status"), beforeId);
  const { results } = await c.env.DB
    .prepare(`SELECT j.id, j.company_id, c.slug, j.kind, j.status, j.attempts, j.scheduled_at, j.sent_at, j.last_error, j.price_cents, j.cost_cents, j.captured_at, j.demo,
               CASE WHEN j.status='sending' AND j.provider_msg_id=''
                 AND (j.last_error LIKE 'Envio sem confirmação%'
                  OR j.last_error LIKE 'Pendente de conferência%'
                  OR j.last_attempt_at < strftime('%Y-%m-%dT%H:%M:%SZ','now','-10 minutes'))
                 THEN 1 ELSE 0 END AS requires_review
               FROM message_jobs j JOIN companies c ON c.id=j.company_id ${where} ORDER BY j.id DESC LIMIT 101`)
    .bind(...binds)
    .all();
  const visible = results.slice(0, 100);
  return json(c, { jobs: visible, next_before_id: results.length > 100 ? visible[visible.length - 1].id : null });
});

/** Somente superadmin, com verificação humana de NÃO envio na Meta. */
superRouter.post("/messages/:id/resolve-not-sent", async (c) => {
  const parsed = z.object({
    confirmed_not_sent: z.literal(true),
    evidence: z.string().trim().min(20).max(500),
  }).strict().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Confirmação explícita e evidência (20–500 caracteres) obrigatórias.", 422);
  const id = idParam(c);
  const db = c.env.DB;
  const job = await db.prepare("SELECT company_id FROM message_jobs WHERE id=?1")
    .bind(id).first<{ company_id: number }>();
  if (!job) return err(c, "Mensagem não encontrada", 404);
  const outcome = await resolveUncertainNotSent(
    db, job.company_id, id, c.get("user").id, parsed.data.evidence
  );
  if (!outcome.ok) return err(c, outcome.error || "Encerramento recusado", 409);
  return json(c, {
    ok: true,
    message: "Encerrado após comprovação de não envio, sem cobrança; reserva liberada.",
  });
});

superRouter.post("/messages/run-cron", async (c) => {
  const companyId = parseOptionalMessageCompanyId(c.req.query("companyId"));
  if (companyId === null) return err(c, "Identificador de barbearia inválido", 400);
  const out = await processDueJobs(c.env, { companyId, limit: 60 });
  await audit(c.env.DB, c.get("user"), "ops.run_cron", "message_jobs", "manual", out, { companyId: null, scope: "platform" });
  return json(c, out);
});

/**
 * Conciliação OPERACIONAL de envio incerto. Exclusivo do superadmin.
 * Confirmar aceite exige ID verificável da Meta; nunca reenviar automaticamente.
 */
superRouter.post("/messages/:id/resolve", async (c) => {
  const parsed = z.discriminatedUnion("decision", [
    z.object({
      decision: z.literal("not_sent"),
      justification: z.string().trim().min(20).max(500),
    }),
    z.object({
      decision: z.literal("confirmed_sent"),
      provider_message_id: z.string().trim().min(12).max(500).regex(/^wamid[.][A-Za-z0-9._:-]+$/),
      justification: z.string().trim().min(20).max(500),
    }),
  ]).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Informe uma decisão válida, justificativa detalhada e, se confirmado, o ID real da mensagem Meta.", 422);

  const db = c.env.DB;
  const id = idParam(c);
  if (!Number.isSafeInteger(id) || id <= 0) return err(c, "Mensagem inválida", 400);
  const d = parsed.data;
  const job = await db.prepare(
    `SELECT id, company_id, status, provider_msg_id, price_cents, reserved_cents,
       captured_at, refunded_at, capture_on, last_error, last_attempt_at
     FROM message_jobs WHERE id=?1`
  ).bind(id).first<{
    id: number; company_id: number; status: string; provider_msg_id: string;
    price_cents: number; reserved_cents: number; captured_at: string | null;
    refunded_at: string | null; capture_on: "sent" | "delivered";
    last_error: string; last_attempt_at: string | null;
  }>();
  if (!job) return err(c, "Mensagem não encontrada", 404);
  const uncertain = job.status === "sending" && !job.provider_msg_id &&
    (job.last_error.startsWith("Envio sem confirmação") ||
     job.last_error.startsWith("Pendente de conferência") ||
     Boolean(job.last_attempt_at && Date.parse(job.last_attempt_at) <= Date.now() - 10 * 60_000));
  if (!uncertain) return err(c, "Esta mensagem não está em revisão por envio indeterminado.", 409);

  if (d.decision === "not_sent") {
    // Todos os caminhos de encerramento usam a MESMA operação atômica D1.
    const outcome = await resolveUncertainNotSent(
      db, job.company_id, job.id, c.get("user").id, d.justification
    );
    if (!outcome.ok) return err(c, outcome.error || "Encerramento recusado", 409);
    return json(c, { ok: true, status: "failed", credited: false });
  }

  // Confirmar somente após conferir um identificador real no provedor.
  const alreadyUsed = await db.prepare(
    `SELECT id FROM message_jobs WHERE provider_msg_id=?1 AND id<>?2`
  ).bind(d.provider_message_id, id).first();
  if (alreadyUsed) return err(c, "Este identificador já está atribuído a outra mensagem.", 409);
  if (job.refunded_at || (job.price_cents > 0 && job.reserved_cents < job.price_cents))
    return err(c, "A reserva financeira não está íntegra; precisa de conciliação individual.", 409);

  const result = await db.prepare(
    `UPDATE message_jobs SET status='sent', provider_msg_id=?1, sent_at=COALESCE(sent_at,?2),
      last_error='', next_attempt_at=NULL, updated_at=?2
     WHERE id=?3 AND company_id=?4 AND status='sending' AND provider_msg_id=''
       AND refunded_at IS NULL AND (price_cents=0 OR reserved_cents >= price_cents)`
  ).bind(d.provider_message_id, nowIso(), id, job.company_id).run();
  if (!result.meta?.changes) return err(c, "O envio foi alterado por outra operação. Atualize o painel.", 409);
  await audit(db, c.get("user"), "message.resolve.confirmed_sent", "message_job", id,
    { decision: "confirmed_sent", provider_message_id: d.provider_message_id, justification: d.justification },
    { companyId: job.company_id, scope: "platform" });

  // Captura somente se a política da barbearia cobra no aceite.
  // Se cobrar na entrega, o webhook futuro fará a captura.
  let captured = false;
  if (job.capture_on === "sent") {
    const { captureJobCharge } = await import("../lib/wallet");
    captured = await captureJobCharge(db, job.company_id, job.id, job.price_cents);
    if (!captured) return err(c, "Envio confirmado, mas a cobrança precisa de conciliação: verifique o extrato.", 503);
  }
  return json(c, { ok: true, status: "sent", captured });
});

// ── auditoria global ─────────────────────────────────────────────────────────
superRouter.get("/audit", async (c) => {
  const scope = c.req.query("scope") || "";
  const companyId = c.req.query("company_id") ? Number(c.req.query("company_id")) : null;
  const conds: string[] = [];
  const binds: (string | number)[] = [];
  if (["company", "platform"].includes(scope)) { conds.push(`scope = ?${binds.length + 1}`); binds.push(scope); }
  if (companyId) { conds.push(`company_id = ?${binds.length + 1}`); binds.push(companyId); }
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const { results } = await c.env.DB.prepare(`SELECT * FROM audit_log ${where} ORDER BY id DESC LIMIT 300`).bind(...binds).all();
  return json(c, { entries: results });
});

// ── LGPD: apagar conta de usuário (direito do titular, via suporte) ─────────
superRouter.post("/users/:id/erase", async (c) => {
  const parsed = z.object({ justification: z.string().min(10).max(300) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Justificativa obrigatória", 400);
  const db = c.env.DB; const uid = idParam(c);
  const u = await db.prepare(`SELECT id, email FROM users WHERE id=?1`).bind(uid).first<{ id: number; email: string }>();
  if (!u) return err(c, "Usuário não encontrado", 404);
  try {
    await db.batch([
      db.prepare(`UPDATE company_memberships SET active=0 WHERE user_id=?1`).bind(uid),
      db.prepare(`DELETE FROM sessions WHERE user_id=?1`).bind(uid),
      db.prepare(`DELETE FROM password_resets WHERE user_id=?1`).bind(uid),
      db.prepare(`UPDATE users SET name='Conta removida (LGPD)', email=?2, password_hash='erased', active=0, last_login_at=NULL WHERE id=?1`).bind(uid, `deleted+${uid}@lgpd.invalid`),
    ]);
  } catch (error) {
    if (String(error).includes("TIGU_LAST_SUPERADMIN")) return err(c, "Mantenha ao menos um Superadmin ativo. Cadastre ou reative outro antes de apagar esta conta.", 409);
    throw error;
  }
  await audit(db, c.get("user"), "user.erase_lgpd", "user", uid, { justification: parsed.data.justification }, { companyId: null, scope: "platform" });
  return json(c, { ok: true, message: "Conta descaracterizada. Histórico operacional permanece por obrigação fiscal, sem PII." });
});

 
// Status não sensível das integrações globais. Segredos permanecem no Cloudflare.
superRouter.get("/integrations/status", async (c) => {
  const e = c.env;
  const sales=await loadSalesContact(e.DB);
  const turnstileSite=Boolean(e.SALES_TURNSTILE_SITE_KEY);
  const turnstileSecret=Boolean(e.SALES_TURNSTILE_SECRET);
  c.header("Cache-Control","no-store");
  return json(c, {
    staging: e.TIGU_STAGING === "1",
    readiness: {
      d1_set: Boolean(e.DB),
      r2_set: Boolean(e.MEDIA),
      session_secret_ready: Boolean(e.SESSION_SECRET && e.SESSION_SECRET.length >= 32),
      encryption_key_ready: Boolean(e.MSG_ENC_KEY && e.MSG_ENC_KEY.length >= 32),
      turnstile_site_key_set: turnstileSite,
      turnstile_secret_set: turnstileSecret,
      leads_form_ready: turnstileSite && turnstileSecret,
      sales_contact_enabled: sales.enabled,
      sales_contact_channel_ready: Boolean(sales.email || sales.whatsapp),
      production_site_ready: e.TIGU_STAGING !== "1",
    },
    payment: {
      access_token_set: Boolean(e.MP_ACCESS_TOKEN),
      webhook_secret_set: Boolean(e.MP_WEBHOOK_SECRET),
      public_url_set: Boolean(e.PUBLIC_URL),
      enabled_in_environment: e.TIGU_STAGING !== "1" && Boolean(e.MP_ACCESS_TOKEN && e.MP_WEBHOOK_SECRET && e.PUBLIC_URL),
      purposes: ["recargas", "assinaturas"],
    },
    whatsapp: {
      app_id_set: Boolean(e.WHATSAPP_APP_ID),
      app_secret_set: Boolean(e.WHATSAPP_APP_SECRET),
      webhook_verify_token_set: Boolean(e.WHATSAPP_WEBHOOK_VERIFY_TOKEN),
      encryption_key_set: Boolean(e.MSG_ENC_KEY),
      embedded_signup_set: Boolean(e.WHATSAPP_EMBEDDED_CONFIG_ID),
      provider_disabled_in_staging: e.TIGU_STAGING === "1",
    },
  });
});

/** Exclusão restrita a cadastros demonstrativos; nunca apaga clientes reais. */
superRouter.delete("/companies/:id/demo", async (c) => {
  const id = idParam(c);
  if (!Number.isSafeInteger(id) || id <= 0) return err(c, "Identificador inválido", 400);
  const db = c.env.DB;
  const company = await db.prepare("SELECT id,name,demo FROM companies WHERE id=?1").bind(id)
    .first<{id:number;name:string;demo:number}>();
  if (!company) return err(c, "Barbearia não encontrada", 404);
  const fixture = /^Tigu (Teste|Isolamento) [a-f0-9]{8}$/i.test(company.name);
  const testOwner = await db.prepare(`SELECT COUNT(*) AS n FROM company_memberships m
    JOIN users u ON u.id=m.user_id WHERE m.company_id=?1 AND m.role='owner'
      AND u.platform_role='user'
      AND (u.email GLOB 'tigu-test-owner-*@example.test' OR u.email GLOB 'tigu-test-other-*@example.test')`)
    .bind(id).first<{n:number}>();
  if (company.demo !== 1 && !(fixture && Number(testOwner?.n) > 0))
    return err(c, "Somente barbearias comprovadamente fictícias podem ser excluídas aqui.", 403);
  const finance = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM wallet_transactions WHERE company_id=?1) AS tx,
    (SELECT COUNT(*) FROM topup_orders WHERE company_id=?1) AS topups,
    (SELECT COUNT(*) FROM subscription_invoices WHERE company_id=?1) AS invoices`)
    .bind(id).first<{tx:number;topups:number;invoices:number}>();
  if (Number(finance?.tx) || Number(finance?.topups) || Number(finance?.invoices))
    return err(c, "Existem movimentações financeiras: exclusão bloqueada para preservar registros.", 409);
  // Nunca remover vínculo de outro usuário/empresa sem confirmação.
  const members=await db.prepare(`SELECT COUNT(*) AS n FROM company_memberships m JOIN users u ON u.id=m.user_id
    WHERE m.company_id=?1 AND u.platform_role='superadmin'`).bind(id).first<{n:number}>();
  if (Number(members?.n)) return err(c,"Barbearia com Super Admin vinculado: exclusão bloqueada.",409);
  try {
    const deleted = await db.prepare("DELETE FROM companies WHERE id=?1 AND (demo=1 OR name GLOB 'Tigu Teste *' OR name GLOB 'Tigu Isolamento *')").bind(id).run();
    if (deleted.meta?.changes !== 1) return err(c,"Cadastro alterado; atualize e tente novamente.",409);
  } catch {
    return err(c,"Não foi possível excluir com segurança: existem registros vinculados. Nada foi apagado.",409);
  }
  await audit(db,c.get("user"),"company.demo_delete","company",id,{demo:company.demo===1},{companyId:null,scope:"platform"});
  return json(c,{ok:true});
});
