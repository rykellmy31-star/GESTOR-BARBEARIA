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
  /** Modo da mensalidade da plataforma; por padrão manual. NÃO afeta pagamentos dos profissionais. */
  TIGU_PLATFORM_BILLING_MODE?: "manual" | "mercadopago";
  /** Site key pública do Cloudflare Turnstile usada no formulário comercial. */
  SALES_TURNSTILE_SITE_KEY?: string;
  /** Secret privado do Turnstile para validar tokens no servidor. */
  SALES_TURNSTILE_SECRET?: string;

  // WhatsApp: exclusivamente Evolution API v2 (sem Graph API, token Meta ou WABA).
  /** HTTPS público do TIGU para receber webhooks. */
  PUBLIC_URL?: string;
  /** Mock interno de testes, não é outra API e não aparece ao cliente. */
  WHATSAPP_MOCK?: string;
  EVOLUTION_API_URL?: string;
  EVOLUTION_API_KEY?: string;
  EVOLUTION_WEBHOOK_SECRET?: string;

  // ── Pagamentos (Pix) ──
  MERCHANT_PIX_ENABLED?: string; // kill-switch de checkout por conta própria da barbearia (não afeta assinatura/recarga)
  MP_ACCESS_TOKEN?: string; // produção ou sandbox (deixe consistente com o ambiente)
  MP_WEBHOOK_SECRET?: string; // validação x-signature
  /** Aplicação separada: OAuth dos vendedores (nunca confundir com MP_ACCESS_TOKEN). */
  MP_MARKETPLACE_CLIENT_ID?: string;
  /** Segredo central OAuth, nunca exposto no client ou logs. */
  MP_MARKETPLACE_CLIENT_SECRET?: string;
  /** Callback HTTPS registrado na aplicação TIGU Marketplace. */
  MP_MARKETPLACE_REDIRECT_URI?: string;
  /** Segredo de assinatura do webhook da aplicação Marketplace de vendedores. */
  MP_MARKETPLACE_WEBHOOK_SECRET?: string;
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
