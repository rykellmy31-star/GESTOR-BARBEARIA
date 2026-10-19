// ============================================================================
// Auth GLOBAL (um login → N barbearias) + onboarding de empresa.
// ============================================================================
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { err, json, nowIso, slugify, uniqueSlug } from "../lib/utils";
import { authRateLimit, createSession, destroySession, currentUser, requireAuth, hashPassword, verifyPassword, publicUser } from "../lib/auth";
import { audit } from "../lib/audit";
import { DEFAULT_SETTINGS } from "../lib/settings";
import { ensureWallet } from "../lib/wallet";
import { sha256hex } from "../lib/crypto";

export const authRouter = new Hono<{ Bindings: Env }>();

authRouter.use("*", authRateLimit(25, 5 * 60_000));

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(6).max(128) });

authRouter.post("/login", async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Informe e-mail e senha", 400);
  const email = parsed.data.email.trim().toLowerCase();
  const db = c.env.DB;
  // rate limit por conta (além do global por IP)
  if (!(await rateAccount(c, email))) return err(c, "Muitas tentativas para esta conta. Aguarde 15 minutos.", 429);
  const u = await db.prepare(`SELECT id, name, email, password_hash, active, must_change_password, platform_role FROM users WHERE email = ?1`).bind(email).first<{
    id: number; name: string; email: string; password_hash: string; active: number; must_change_password: number; platform_role: "user" | "superadmin";
  }>();
  if (!u || !(await verifyPassword(parsed.data.password, u.password_hash))) {
    await audit(db, null, "login.failed", "user", email, {}, { companyId: null, scope: "platform" });
    return err(c, "E-mail ou senha incorretos", 401);
  }
  if (!u.active) return err(c, "Conta desativada. Contate o suporte Tigu.", 403);
  await createSession(c, u.id);
  await db.batch([
    db.prepare(`UPDATE users SET last_login_at = ?2 WHERE id = ?1`).bind(u.id, nowIso()),
    db.prepare(`DELETE FROM password_resets WHERE user_id = ?1 AND used_at IS NULL`).bind(u.id),
  ]);
  const companies = await myCompanies(db, u.id);
  await audit(db, { id: u.id, name: u.name, email: u.email, platform_role: u.platform_role }, "login", "user", u.id, {}, { companyId: null, scope: "platform" });
  return json(c, {
    user: { ...publicUser({ id: u.id, name: u.name, email: u.email, platform_role: u.platform_role }), must_change_password: u.must_change_password === 1 },
    companies,
    next: u.platform_role === "superadmin" ? "/superadmin" : companies.length === 1 ? `/c/${companies[0].slug}/admin` : companies.length ? "/selecionar" : "/comecar",
  });
});

async function rateAccount(c: { env: Env }, email: string): Promise<boolean> {
  const { rateLimit } = await import("../lib/auth");
  return rateLimit(`login:${email}`, 8, 15 * 60_000);
}

authRouter.post("/logout", async (c) => {
  await destroySession(c);
  return json(c, { ok: true });
});

authRouter.get("/me", async (c) => {
  const u = await currentUser(c);
  if (!u) return json(c, { user: null });
  const companies = await myCompanies(c.env.DB, u.id);
  return json(c, { user: { ...publicUser(u), companies } });
});

const registerSchema = z.object({
  company_name: z.string().min(3).max(80),
  email: z.string().email(),
  password: z.string().min(10).max(128),
  name: z.string().min(2).max(90),
  phone: z.string().max(20).default("").optional(),
  city: z.string().max(80).default("").optional(),
});

/** Onboarding: cria usuário + empresa + settings + wallet + plano free. Tudo ou nada (por etapas idempotentes). */
authRouter.post("/register", async (c) => {
  if (!(await rateAccount(c, `signup:${c.req.header("cf-connecting-ip") || "local"}`))) return err(c, "Muitos cadastros deste endereço. Tente mais tarde.", 429);
  const parsed = registerSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Dados incompletos (senha de no mínimo 10 caracteres)", 422, parsed.error.flatten().fieldErrors);
  const { company_name, name } = parsed.data;
  const email = parsed.data.email.trim().toLowerCase();
  const db = c.env.DB;

  const dup = await db.prepare(`SELECT id FROM users WHERE email = ?1`).bind(email).first();
  if (dup) return err(c, "Este e-mail já possui conta — faça login.", 409);

  const passwordHash = await hashPassword(parsed.data.password);
  const insUser = await db
    .prepare(`INSERT INTO users (platform_role, name, email, password_hash, active, created_at) VALUES ('user', ?1, ?2, ?3, 1, ?4)`)
    .bind(name.trim(), email, passwordHash, nowIso())
    .run();
  const userId = insUser.meta.last_row_id as number;

  const base = slugify(company_name) || "barbearia";
  const slug = await uniqueSlug(db, "companies", base);
  const insCo = await db
    .prepare(`INSERT INTO companies (slug, name, status, plan_code, created_at, updated_at) VALUES (?1, ?2, 'active', 'free', ?3, ?3)`)
    .bind(slug, company_name.trim(), nowIso())
    .run();
  const companyId = insCo.meta.last_row_id as number;

  const settings = { ...DEFAULT_SETTINGS, shop_name: company_name.trim(), phone: parsed.data.phone ?? "" };
  await db.batch([
    db.prepare(`INSERT INTO company_settings (company_id, data, updated_at) VALUES (?1, ?2, ?3)`).bind(companyId, JSON.stringify(settings), nowIso()),
    db.prepare(`INSERT INTO company_memberships (company_id, user_id, role, active, created_at) VALUES (?1, ?2, 'owner', 1, ?3)`).bind(companyId, userId, nowIso()),
    db.prepare(`INSERT INTO subscriptions (company_id, plan_code, status, started_at, updated_at) VALUES (?1, 'free', 'trial', ?2, ?2)`).bind(companyId, nowIso()),
    db.prepare(`INSERT OR IGNORE INTO wallets (company_id, updated_at) VALUES (?1, ?2)`).bind(companyId, nowIso()),
    db.prepare(`INSERT INTO notifications (company_id, audience, title, body, kind) VALUES (?1,'admin','Bem-vindo à Tigu!','Complete seu perfil, cadastre serviços e barbeiros. Dica: o plano gratuito testa a agenda; o WhatsApp liga no plano Pro.','system')`).bind(companyId),
  ]);
  await ensureWallet(db, companyId);
  await audit(db, { id: userId, name, email, platform_role: "user" }, "signup", "company", companyId, { slug }, { companyId });
  await createSession(c, userId);
  return json(c, { ok: true, company: { slug, name: company_name }, next: `/c/${slug}/admin` }, 201);
});

async function myCompanies(db: D1Database, userId: number) {
  const { results } = await db
    .prepare(
      `SELECT c.slug, c.name, c.status, m.role, p.name AS plan
       FROM company_memberships m JOIN companies c ON c.id = m.company_id
       JOIN subscriptions s ON s.company_id = c.id JOIN plans p ON p.code = s.plan_code
       WHERE m.user_id = ?1 AND m.active = 1 ORDER BY c.name`
    )
    .bind(userId)
    .all();
  return results;
}

const changePwSchema = z.object({ current: z.string().min(6), next: z.string().min(10).max(128) });
authRouter.post("/password", requireAuth, async (c) => {
  const parsed = changePwSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return err(c, "Senha atual incorreta ou nova senha muito curta (mín. 10)", 422);
  const u = c.get("user");
  const row = await c.env.DB.prepare(`SELECT password_hash FROM users WHERE id = ?1`).bind(u.id).first<{ password_hash: string }>();
  if (!row || !(await verifyPassword(parsed.data.current, row.password_hash))) return err(c, "Senha atual incorreta", 401);
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE users SET password_hash = ?1, must_change_password = 0 WHERE id = ?2`).bind(await hashPassword(parsed.data.next), u.id),
    c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(u.id),
  ]);
  await createSession(c, u.id);
  await audit(c.env.DB, u, "password.change", "user", u.id, {}, { companyId: null, scope: "platform" });
  return json(c, { ok: true, message: "Senha alterada. Outras sessões foram encerradas." });
});

// ── Recuperação de senha (sem serviço de e-mail: código de uso único) ──────
// Fluxo honesto: gera código de 10 caracteres com validade de 30 min. A
// ENTREGA depende do canal disponível: em empresas demo/mock o código é
// retornado na própria resposta (marcado como demonstração); em produção o
// atendente da barbearia pode re-definir a senha de staff pelo painel, e o
// dono de empresa contata o suporte Tigu (superadmin pode gerar/ver código
// ativo do reset para confirmar por WhatsApp/e-mail manual do próprio suporte).
authRouter.post("/recover", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string };
  const email = (body.email || "").trim().toLowerCase();
  const db = c.env.DB;
  const u = email ? await db.prepare(`SELECT id, demo FROM users WHERE email = ?1 AND active = 1`).bind(email).first<{ id: number; demo: number }>() : null;
  const generic = { ok: true, message: "Se o e-mail tiver conta, um código de recuperação foi gerado." };
  if (!u) return json(c, generic);
  if (!(await rateAccount(c, `reset:${email}`))) return err(c, "Muitas tentativas de recuperação. Aguarde.", 429);
  const raw = Array.from(crypto.getRandomValues(new Uint8Array(5))).map((b) => b.toString(36).padStart(2, "0")).join("").toUpperCase().slice(0, 10);
  const codeHash = await sha256hex(`${raw}:${u.id}`);
  await db.batch([
    db.prepare(`UPDATE password_resets SET used_at = ?1 WHERE user_id = ?2 AND used_at IS NULL`).bind(nowIso(), u.id),
    db.prepare(`INSERT INTO password_resets (user_id, code_hash, expires_at, created_at) VALUES (?1,?2, strftime('%Y-%m-%dT%H:%M:%SZ','now','+30 minutes'), ?3)`).bind(u.id, codeHash, nowIso()),
  ]);
  await audit(db, null, "password.recover_request", "user", u.id, {}, { companyId: null, scope: "platform" });
  if (u.demo === 1 || c.env.APP_ENV !== "production") {
    return json(c, { ...generic, demo_code: raw, note: "AMBIENTE DE DEMONSTRAÇÃO: o código é mostrado aqui; em produção ele seria entregue por um canal seguro." });
  }
  return json(c, generic);
});

authRouter.post("/recover/verify", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { email?: string; code?: string; password?: string };
  const email = (body.email || "").trim().toLowerCase();
  const db = c.env.DB;
  const u = await db.prepare(`SELECT id FROM users WHERE email = ?1 AND active = 1`).bind(email).first<{ id: number }>();
  if (!u) return err(c, "Código inválido", 400);
  if (!body.password || body.password.length < 10) return err(c, "Nova senha precisa de 10+ caracteres", 422);
  const codeHash = await sha256hex(`${(body.code || "").toUpperCase()}:${u.id}`);
  const r = await db.prepare(`SELECT id, attempts FROM password_resets WHERE user_id = ?1 AND code_hash = ?2 AND used_at IS NULL AND expires_at > ?3`).bind(u.id, codeHash, nowIso()).first<{ id: number; attempts: number }>();
  if (!r) return err(c, "Código inválido ou expirado", 400);
  if (r.attempts >= 5) return err(c, "Muitas tentativas com este código. Gere um novo.", 429);
  await db.batch([
    db.prepare(`UPDATE password_resets SET used_at = ?2 WHERE id = ?1`).bind(r.id, nowIso()),
    db.prepare(`UPDATE users SET password_hash = ?1, must_change_password = 0 WHERE id = ?2`).bind(await hashPassword(body.password), u.id),
    db.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(u.id),
  ]);
  await audit(db, null, "password.reset", "user", u.id, {}, { companyId: null, scope: "platform" });
  return json(c, { ok: true, message: "Senha redefinida. Faça login com a nova senha." });
});
