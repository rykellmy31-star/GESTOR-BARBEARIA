// ============================================================================
// Autenticação global (1 usuário → N empresas) + sessões D1 + CSRF por origin
// + rate limit em memória (adequado p/ escala inicial; trocar por Durable
// Objects/Turnstile quando houver tráfego real).
// ============================================================================
import type { Context } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { createFactory } from "hono/factory";
import { sha256hex } from "./crypto";
import type { Env, SessionUser } from "../types";
import { err, nowIso } from "./utils";

const factory = createFactory<{ Bindings: Env }>();

const COOKIE_NAME = "aurum_session"; // nome mantido p/ compatibilidade local; domínio é isolado por path
const COOKIE_OPTS = {
  httpOnly: true,
  secure: true,
  sameSite: "Lax" as const,
  path: "/",
  maxAge: 60 * 60 * 24 * 7,
};

export async function sha(s: string): Promise<string> {
  return sha256hex(s);
}

function secretOf(env: Env): string {
  if (env.APP_ENV === "production" && (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32)) {
    throw new Error("SESSION_SECRET forte não configurado. Configure um secret exclusivo de pelo menos 32 caracteres.");
  }
  return env.SESSION_SECRET || "dev-insecure-secret-change-me";
}

export async function createSession(c: Context<{ Bindings: Env }>, userId: number): Promise<void> {
  // assinatura: token_hash derivado de token aleatório + segredo + uid
  const token = Array.from(crypto.getRandomValues(new Uint8Array(24))).map((b) => b.toString(16).padStart(2, "0")).join("");
  const tokenHash = await sha(`${token}:${secretOf(c.env)}:${userId}`);
  const expiresAt = new Date(Date.now() + COOKIE_OPTS.maxAge * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT OR REPLACE INTO sessions (token_hash, user_id, expires_at, last_seen_at, created_at) VALUES (?1,?2,?3,?3,?4)`).bind(tokenHash, userId, expiresAt, nowIso()),
    c.env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?1`).bind(nowIso()),
  ]);
  setCookie(c, COOKIE_NAME, `uid.${userId}.${token}`, COOKIE_OPTS);
}

export async function destroySession(c: Context<{ Bindings: Env }>): Promise<void> {
  const v = getCookie(c, COOKIE_NAME);
  const parts = v?.split(".");
  if (parts?.length === 3 && /^\d+$/.test(parts[1])) {
    const uid = parseInt(parts[1], 10);
    const tokenHash = await sha(`${parts[2]}:${secretOf(c.env)}:${uid}`);
    await c.env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1 AND token_hash = ?2`).bind(uid, tokenHash).run();
  }
  deleteCookie(c, COOKIE_NAME, { path: "/" });
}

export async function currentUser(c: Context<{ Bindings: Env }>): Promise<SessionUser | null> {
  const v = getCookie(c, COOKIE_NAME);
  if (!v) return null;
  const parts = v.split(".");
  if (parts.length !== 3 || parts[0] !== "uid" || !/^\d+$/.test(parts[1])) return null;
  const uid = parseInt(parts[1], 10);
  const tokenHash = await sha(`${parts[2]}:${secretOf(c.env)}:${uid}`);
  const row = await c.env.DB
    .prepare(`SELECT u.id, u.name, u.email, u.platform_role, u.must_change_password
               FROM users u JOIN sessions s ON s.user_id = u.id
               WHERE s.user_id = ?1 AND s.token_hash = ?2 AND u.active = 1 AND s.expires_at > ?3`)
    .bind(uid, tokenHash, nowIso())
    .first<{ id: number; name: string; email: string; platform_role: "user" | "superadmin"; must_change_password: number }>();
  if (!row) return null;
  // renovação "sliding" assíncrona (não bloqueia a request)
  c.executionCtx?.waitUntil?.(c.env.DB.prepare(`UPDATE sessions SET last_seen_at = ?2 WHERE token_hash = ?1`).bind(tokenHash, nowIso()).run());
  return { id: row.id, name: row.name, email: row.email, platform_role: row.platform_role, must_change_password: row.must_change_password === 1 };
}

export async function currentUserOptional(c: Context<{ Bindings: Env }>): Promise<SessionUser | null> {
  try {
    return await currentUser(c);
  } catch {
    return null;
  }
}

export const requireAuth = factory.createMiddleware(async (c, next) => {
  const u = await currentUser(c);
  if (!u) return err(c, "Não autenticado. Faça login para continuar.", 401);
  if (u.must_change_password && c.req.path !== "/api/auth/password")
    return err(c, "Você precisa alterar a senha provisória antes de acessar esta área.", 403);
  c.set("user", u);
  await next();
});

export const requireSuper = factory.createMiddleware(async (c, next) => {
  const u = await currentUser(c);
  if (!u) return err(c, "Não autenticado.", 401);
  if (u.platform_role !== "superadmin") return err(c, "Acesso restrito à plataforma Tigu.", 403);
  if (u.must_change_password) return err(c, "Troque a senha provisória antes de acessar o Superadmin.", 403);
  c.set("user", u);
  await next();
});

/** origem/CSRF */
export const originGuard = factory.createMiddleware(async (c, next) => {
  const method = c.req.method;
  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const origin = c.req.header("origin");
    if (origin) {
      const host = c.req.header("host");
      try {
        if (new URL(origin).host !== host) return err(c, "Origem não permitida", 403);
      } catch {
        return err(c, "Origem inválida", 403);
      }
    } else {
      const ct = c.req.header("content-type") || "";
      if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
        return err(c, "Requisições cross-origin de formulário não são permitidas", 403);
      }
    }
  }
  await next();
});

// ── rate limiting ───────────────────────────────────────────────────────────
interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

/** true se permitido; incrementa bucket. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 5000) {
      for (const [k, v] of buckets) if (v.resetAt < now) buckets.delete(k);
    }
    return true;
  }
  if (b.count >= limit) return false;
  b.count++;
  return true;
}

export const authRateLimit =
  (limit = 10, windowMs = 5 * 60_000) =>
  async (c: Context<{ Bindings: Env }>, next: () => Promise<void>) => {
    const ip = c.req.header("cf-connecting-ip") || c.req.header("x-forwarded-for")?.split(",")[0] || "local";
    const scope = c.req.path.replace(/^\/api\/c\/[a-z0-9-]+/, "");
    if (!rateLimit(`auth:${ip}:${scope}`, limit, windowMs)) {
      return err(c, "Muitas tentativas. Aguarde alguns minutos e tente novamente.", 429);
    }
    await next();
  };

// helpers de senha usados pelas rotas
export { hashPassword, verifyPassword } from "./crypto";

export const publicUser = (u: SessionUser) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  platform_role: u.platform_role,
  must_change_password: u.must_change_password === true,
  company: u.company
    ? { slug: u.company.slug, name: u.company.name, role: u.company.role, barber_id: u.company.barber_id, plan: u.company.plan.code }
    : null,
});

export { COOKIE_NAME };
