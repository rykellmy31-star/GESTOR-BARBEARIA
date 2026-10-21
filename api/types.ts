// Tipos de ambiente do Worker (Cloudflare bindings + variáveis/secrets)
export interface Env {
  DB: D1Database;
  MEDIA?: R2Bucket;
  ASSETS?: Fetcher;

  /** Sessão (obrigatório em produção). */
  SESSION_SECRET?: string;
  /** Chave para cifrar tokens de WhatsApp em repouso (AES-256-GCM). */
  MSG_ENC_KEY?: string;
  APP_ENV?: string;
  /** Worker isolado de homologação: impede provedores e webhooks reais. */
  TIGU_STAGING?: string;
  /** Site key pública do Cloudflare Turnstile usada no formulário comercial. */
  SALES_TURNSTILE_SITE_KEY?: string;
  /** Secret privado do Turnstile para validar tokens no servidor. */
  SALES_TURNSTILE_SECRET?: string;

  // ── WhatsApp (Meta Cloud API) — APP-level; credenciais por empresa vêm do DB ──
  /** URL pública da plataforma (usada em callbacks/links), ex.: https://tigu.com.br */
  PUBLIC_URL?: string;
  /** Token de verificação do webhook (hub.verify_token) */
  WHATSAPP_WEBHOOK_VERIFY_TOKEN?: string;
  /** App secret p/ validar x-hub-signature-256 dos webhooks */
  WHATSAPP_APP_SECRET?: string;
  /** Versão da Graph API (fixar para previsibilidade) */
  GRAPH_API_VERSION?: string;
  /** Embedded Signup config id (opcional; sem ele a UI orienta o fluxo manual) */
  WHATSAPP_EMBEDDED_CONFIG_ID?: string;
  /** App id/secret do META app (para Exchange Code do Embedded Signup) */
  WHATSAPP_APP_ID?: string;
  WHATSAPP_APP_SECRET_FOR_OAUTH?: string;
  /** Liga o provedor 'mock' (NUNCA habilitar em produção) */
  WHATSAPP_MOCK?: string;

  // ── Pagamentos (Pix) ──
  MERCHANT_PIX_ENABLED?: string; // kill-switch de checkout por conta própria da barbearia (não afeta assinatura/recarga)
  MP_ACCESS_TOKEN?: string; // produção ou sandbox (deixe consistente com o ambiente)
  MP_WEBHOOK_SECRET?: string; // validação x-signature
  PAYMENTS_MOCK?: string; // '1' habilita provedor mock (dev/testes)
}

export interface SessionUser {
  id: number;
  name: string;
  email: string;
  platform_role: "user" | "superadmin";
  must_change_password?: boolean;
  /** company context preenchido pelo middleware tenant */
  company?: {
    id: number;
    slug: string;
    name: string;
    role: "owner" | "manager" | "barber" | "public";
    barber_id: number | null;
    plan: { code: string; whatsapp_enabled: number; max_barbers: number; max_messages_month: number };
  };
}

declare module "hono" {
  interface ContextVariableMap {
    user: SessionUser;
    company: NonNullable<SessionUser["company"]>;
    settings: import("./lib/settings").CompanySettings;
  }
}
