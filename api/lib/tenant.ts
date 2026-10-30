// ============================================================================
// Tenant resolver — a ÚNICA forma de o backend saber "de quem são os dados".
// O slug vem da URL; a empresa é buscada POR SLUG e o papel do usuário é
// verificado em company_memberships a cada request. Nada de confiança no
// client. Empresa suspensa → 402/403 honestos.
// ============================================================================
import type { Context, MiddlewareHandler } from "hono";
import type { Env, SessionUser } from "../types";
import { err } from "./utils";
import { loadCompanySettings } from "./settings";
import { currentUserOptional } from "./auth";
import { canOperateSubscription, requiresSubscriptionToWrite, subscriptionAccess, isSubscriptionBillingAction } from "./trial";
import type { CompanySettings } from "./settings";

export interface CompanyRow {
  id: number;
  slug: string;
  name: string;
  status: "active" | "suspended";
  suspend_reason: string;
  demo: number;
}

export async function findCompanyBySlug(db: D1Database, slug: string): Promise<CompanyRow | null> {
  return db.prepare(`SELECT id, slug, name, status, suspend_reason, demo FROM companies WHERE slug = ?1`).bind(slug).first<CompanyRow>();
}

interface MembershipRow {
  role: "owner" | "manager" | "barber";
  barber_id: number | null;
  plan_code: string;
  whatsapp_enabled: number;
  max_barbers: number;
  max_messages_month: number;
}

export async function getMembership(db: D1Database, userId: number, companyId: number): Promise<MembershipRow | null> {
  return db
    .prepare(
      `SELECT m.role, m.barber_id, s.plan_code, p.whatsapp_enabled, p.max_barbers, p.max_messages_month
       FROM company_memberships m
       JOIN subscriptions s ON s.company_id = m.company_id
       JOIN plans p ON p.code = s.plan_code
       WHERE m.user_id = ?1 AND m.company_id = ?2 AND m.active = 1
         AND (m.role <> 'barber' OR EXISTS(
           SELECT 1 FROM barbers b WHERE b.id=m.barber_id AND b.company_id=m.company_id AND b.active=1
         ))`
    )
    .bind(userId, companyId)
    .first<MembershipRow>();
}

/**
 * Middleware: monta c.var.company + c.var.settings + user.company.
 * `auth`: se true, exige sessão com papel permitido (owner/manager p/ painel).
 */
export const tenantMiddleware =
  (opts: { auth: "none" | "company" | "admin" | "barber" | "admin_or_barber" }): MiddlewareHandler<{ Bindings: Env }> =>
  async (c, next) => {
    const slug = c.req.param("slug");
    if (!slug || !/^[a-z0-9-]{3,80}$/.test(slug)) return err(c, "Barbearia inválida", 404);
    const company = await findCompanyBySlug(c.env.DB, slug);
    if (!company) return err(c, "Esta barbearia não existe (ou o endereço mudou).", 404);
    if (company.status === "suspended") return err(c, `Esta barbearia está temporariamente suspensa${company.suspend_reason ? `: ${company.suspend_reason}` : ""}.`, 403);

    const user: SessionUser | null = await currentUserOptional(c);
    const settings = await loadCompanySettings(c.env.DB, company.id);

    if (opts.auth !== "none") {
      if (!user) return err(c, "Não autenticado. Faça login para continuar.", 401);
      if (user.must_change_password) return err(c, "Altere sua senha provisória antes de acessar a barbearia.", 403);
      let m = await getMembership(c.env.DB, user.id, company.id);

      // O painel Super Admin oferece "abrir painel (assumido)" por empresa.
      // Sem vínculo, um Super Admin só pode CONSULTAR os endpoints administrativos
      // daquele slug; qualquer escrita exige vínculo owner/manager real.
      // O usuário comum nunca recebe esta exceção.
      if (!m && user.platform_role === "superadmin" && opts.auth === "admin") {
        if (c.req.method !== "GET" && c.req.method !== "HEAD")
          return err(c, "Modo suporte: somente consulta. Para alterar dados, utilize as ações auditadas do Super Admin ou uma conta vinculada à barbearia.", 403);
        const plan = await c.env.DB.prepare(
          `SELECT s.plan_code, p.whatsapp_enabled, p.max_barbers, p.max_messages_month
           FROM subscriptions s JOIN plans p ON p.code=s.plan_code WHERE s.company_id=?1`
        ).bind(company.id).first<Pick<MembershipRow,
          "plan_code" | "whatsapp_enabled" | "max_barbers" | "max_messages_month">>();
        if (!plan) return err(c, "Plano da barbearia não encontrado. Verifique o cadastro em Super Admin.", 409);
        m = { ...plan, role: "owner", barber_id: null };
        c.header("X-Tigu-Support-Mode", "read-only");
        c.header("Cache-Control", "no-store");
      }
      if (!m) return err(c, "Você não tem acesso a esta barbearia.", 403);
      if (opts.auth === "admin" && !["owner", "manager"].includes(m.role)) return err(c, "Apenas proprietário/gerente acessam este recurso.", 403);
      if (opts.auth === "barber" && m.role !== "barber") return err(c, "Área exclusiva do profissional.", 403);
      if (opts.auth === "admin_or_barber" && !["owner", "manager", "barber"].includes(m.role)) return err(c, "Sem permissão.", 403);
      user.company = {
        id: company.id,
        slug: company.slug,
        name: company.name,
        role: m.role,
        barber_id: m.barber_id,
        plan: { code: m.plan_code, whatsapp_enabled: m.whatsapp_enabled, max_barbers: m.max_barbers, max_messages_month: m.max_messages_month },
      };
      c.set("user", user);
      c.set("company", user.company);
    } else {
      // rota pública: só expõe {id, slug, name} para as queries
      c.set("company", { id: company.id, slug: company.slug, name: company.name, role: "public", barber_id: null, plan: { code: "public", whatsapp_enabled: 0, max_barbers: 0, max_messages_month: 0 } });
    }
    // Evita novas reservas/alterações após o fim dos 15 dias, sem apagar
    // informações nem impedir consulta ou cancelamento de reservas existentes.
    const writeRequiresSubscription = requiresSubscriptionToWrite(
      c.req.method, c.req.path, opts.auth !== "none"
    );
    if (writeRequiresSubscription && !isSubscriptionBillingAction(c.req.method,c.req.path)) {
      const subscription = await subscriptionAccess(c.env.DB, company.id);
      if (!canOperateSubscription(subscription)) return err(c,
        "Seu teste ou assinatura venceu. Acesse Assinatura no painel e solicite a renovação ao responsável pela plataforma.", 402);
    }

    c.set("settings", settings);
    await next();
  };

/** Helper de tipo pra dentro das rotas */
export function cid(c: Context<{ Bindings: Env }>): number {
  return (c.get("company") as { id: number }).id;
}
export function ctxSettings(c: Context<{ Bindings: Env }>): CompanySettings {
  return c.get("settings") as CompanySettings;
}
