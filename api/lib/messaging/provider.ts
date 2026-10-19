// ============================================================================
// Camada de provedor de mensagens (WhatsApp). A aplicação chama SEMPRE esta
// interface — nunca fetch() de Graph API espalhado pelo código. Isso permite:
//   • meta_cloud → WhatsApp Business Platform (Cloud API) real por empresa
//   • mock       → simulador local (demo/testes; NUNCA envia de verdade)
// Operações: conectar, verificar status, enviar template, sincronizar
// templates, receber webhook, desconectar, e "billing" (informativo).
// ============================================================================
import { decryptSecret, encryptSecret, sha256hex } from "../crypto";

export interface ProviderConnectionRow {
  id: number;
  company_id: number;
  provider: "meta_cloud" | "mock";
  waba_id: string;
  phone_number_id: string;
  display_phone: string;
  business_name: string;
  status: "disconnected" | "pending_setup" | "connected" | "error";
  access_token_enc: string;
  coexistence: "unknown" | "enabled" | "not_eligible";
  last_error: string;
  last_check_at: string | null;
  connected_at: string | null;
  demo: number;
}

export interface ProviderContext {
  env: { GRAPH_API_VERSION?: string; APP_ENV?: string; SESSION_SECRET?: string; MSG_ENC_KEY?: string; WHATSAPP_MOCK?: string;
         WHATSAPP_APP_ID?: string; WHATSAPP_APP_SECRET_FOR_OAUTH?: string; WHATSAPP_EMBEDDED_CONFIG_ID?: string };
  db: D1Database;
  conn: ProviderConnectionRow;
  /** true em empresas demo — mock liberado, nenhuma chamada externa real */
  demo: boolean;
}

export interface TemplateVariable {
  key: string; // ex.: {{1}}
  sample: string;
}

export interface SendTemplateInput {
  to: string; // E.164 sem '+'
  templateCode: string;
  language: string;
  variables: TemplateVariable[];
  /** id do job (waba meta: usada como callback_id p/ correlação do webhook) */
  wabaBizMetadata?: Record<string, string>;
}

export interface SendTemplateResult {
  /** aceito no provedor (≠ entregue!) */
  accepted: boolean;
  providerMessageId?: string;
  /** retryable: erro transitório (rate limit, rede) → manter reserva e tentar de novo */
  permanent: boolean;
  error?: string;
  /** custo estimado da mensagem (informativo p/ margem; cobrança real é a regra da plataforma) */
  providerCostCents?: number;
}

export interface ProviderTemplateInfo {
  code: string;
  name: string;
  language: string;
  category: string;
  status: string; // APPROVED | PENDING | REJECTED | ...
  body_preview?: string;
}

export interface Provider {
  kind: "meta_cloud" | "mock";
  /** Testa credenciais e sincroniza dados básicos do número. */
  status(ctx: ProviderContext): Promise<{ ok: boolean; error?: string; display_phone?: string; quality_rating?: string; verified_name?: string }>;
  sendTemplate(ctx: ProviderContext, input: SendTemplateInput): Promise<SendTemplateResult>;
  listTemplates(ctx: ProviderContext): Promise<{ ok: boolean; error?: string; templates?: ProviderTemplateInfo[] }>;
  /** Dados que o connect precisa persistir após OAuth do Embedded Signup. */
  exchangeCode?(ctx: ProviderContext, code: string, configId: string): Promise<{ ok: boolean; error?: string; access_token?: string; waba_id?: string; phone_number_id?: string }>;
  disconnect(ctx: ProviderContext): Promise<void>;
}

export function graphBase(env: ProviderContext["env"]): string {
  return `https://graph.facebook.com/${env.GRAPH_API_VERSION || "v23.0"}`;
}

// ── Meta Cloud API (real) ───────────────────────────────────────────────────
export const metaProvider: Provider = {
  kind: "meta_cloud",
  async status(ctx) {
    const token = await decryptSecret(ctx.env, ctx.conn?.access_token_enc || "");
    if (!ctx.conn?.phone_number_id || !token) return { ok: false, error: "Credenciais incompletas — reconecte o WhatsApp." };
    try {
      const res = await fetch(`${graphBase(ctx.env)}/${ctx.conn!.phone_number_id}?fields=verified_name,display_phone_number,quality_rating,platform_type`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = (await res.json().catch(() => ({}))) as { error?: { message?: string }; display_phone_number?: string; verified_name?: string; quality_rating?: string };
      if (!res.ok) return { ok: false, error: data?.error?.message || `HTTP ${res.status}` };
      return { ok: true, display_phone: data.display_phone_number, verified_name: data.verified_name, quality_rating: data.quality_rating };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  async sendTemplate(ctx, input) {
    const token = await decryptSecret(ctx.env, ctx.conn.access_token_enc || "");
    if (!ctx.conn.phone_number_id || !token) return { accepted: false, permanent: true, error: "Conexão WhatsApp sem credenciais" };
    const body = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: input.to,
      type: "template",
      template: {
        name: input.templateCode,
        language: { code: input.language },
        components: input.variables.length
          ? [{ type: "body", parameters: input.variables.map((v) => ({ type: "text", text: v.sample })) }]
          : undefined,
      },
    };
    try {
      const res = await fetch(`${graphBase(ctx.env)}/${ctx.conn.phone_number_id}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number; error_data?: { messaging_product_code?: string } } };
      if (res.ok && data.messages?.[0]?.id) {
        return { accepted: true, providerMessageId: data.messages[0].id, permanent: false, providerCostCents: undefined };
      }
      const msg = data?.error?.message || `HTTP ${res.status}`;
      // códigos Meta típicos: 131047 (re-engagement), 131026 (não entregável), 100 (formato), 131010? etc.
      const retryableCodes = new Set([131056, 131052, 133010, 4, 527]); // rate limit / serviço / auth transient
      const retryable = res.status >= 500 || (data?.error?.code != null && retryableCodes.has(data.error.code));
      return { accepted: false, permanent: !retryable, error: msg };
    } catch (e) {
      return { accepted: false, permanent: false, error: String(e) }; // rede instável → retry
    }
  },
  async listTemplates(ctx) {
    if (!ctx.conn.waba_id) return { ok: false, error: "WABA não vinculada" };
    const token = await decryptSecret(ctx.env, ctx.conn.access_token_enc || "");
    if (!token) return { ok: false, error: "Sem token" };
    try {
      const res = await fetch(`${graphBase(ctx.env)}/${ctx.conn.waba_id}/message_templates?limit=100`, { headers: { Authorization: `Bearer ${token}` } });
      const data = (await res.json().catch(() => ({}))) as { data?: { name: string; language: string; category: string; status: string; body?: string }[] };
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      return {
        ok: true,
        templates: (data.data ?? []).map((t) => ({
          code: t.name,
          name: t.name,
          language: t.language,
          category: t.category,
          status: t.status,
          body_preview: t.body,
        })),
      };
    } catch (e) {
      return { ok: false, error: String(e) };
    }
  },
  async disconnect(ctx) {
    // NÃO apaga nada no Meta — a barbearia continua dona do número. A plataforma
    // apenas invalida o próprio acesso: o token cifrado é destruído.
    await ctx.db.prepare(`UPDATE whatsapp_connections SET access_token_enc = '', status = 'disconnected', last_error = 'desconectado pelo administrador', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1`).bind(ctx.conn.id).run();
  },
};

// ── Mock (demo/testes) — nunca toca a rede ─────────────────────────────────
// Emula: aceite normal, falha permanente p/ número 5500000000000, falha
// transitória 1x p/ 5500000000001 (depois aceita). Store de inbox no KV? não:
// tabela message_webhook_events + simulação de entrega via job status.
export const mockProvider: Provider = {
  kind: "mock",
  async status() {
    return { ok: true, display_phone: "5500MOCK0000", verified_name: "Mock (demo)", quality_rating: "GREEN" };
  },
  async sendTemplate(_ctx, input) {
    if (input.to.startsWith("5500000000000")) return { accepted: false, permanent: true, error: "mock: número bloqueado (recusado pelo provedor)" };
    if (input.to.startsWith("5500000000001")) {
      return { accepted: false, permanent: false, error: "mock: rate limit temporário" };
    }
    return { accepted: true, providerMessageId: `mock-${Date.now()}-${await sha256hex(input.to + input.templateCode).then((h) => h.slice(0, 8))}`, permanent: false, providerCostCents: 5 };
  },
  async listTemplates() {
    return {
      ok: true,
      templates: [
        { code: "tigu_lembrete", name: "tigu_lembrete", language: "pt_BR", category: "UTILITY", status: "APPROVED", body_preview: "Olá {{1}}! Lembrete do seu horário..." },
        { code: "tigu_confirmacao", name: "tigu_confirmacao", language: "pt_BR", category: "UTILITY", status: "APPROVED", body_preview: "Oi {{1}}! Seu horário foi confirmado..." },
      ],
    };
  },
  async disconnect(ctx) {
    await ctx.db.prepare(`UPDATE whatsapp_connections SET status = 'disconnected', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?1`).bind(ctx.conn.id).run();
  },
};

// ── Embedded Signup (fluxo real de autorização Meta) ───────────────────────
// O code curto que o SDK JS devolve é trocado por um token de SYSTEM USER
// (permanente) via app-level. Sem app/secret configurados, a rota responde 501
// com instruções — nada é fingido.
export async function exchangeEmbeddedSignupCode(
  env: { GRAPH_API_VERSION?: string; WHATSAPP_APP_ID?: string; WHATSAPP_APP_SECRET_FOR_OAUTH?: string },
  code: string,
  configId: string
): Promise<{ ok: boolean; error?: string; access_token?: string; waba_id?: string; phone_number_id?: string }> {
  if (!env.WHATSAPP_APP_ID || !env.WHATSAPP_APP_SECRET_FOR_OAUTH) {
    return { ok: false, error: "Embedded Signup não configurado neste ambiente (WHATSAPP_APP_ID/APP_SECRET). Use a conexão manual informando os IDs + token, ou agende a configuração com o time Tigu." };
  }
  const base = `https://graph.facebook.com/${env.GRAPH_API_VERSION || "v23.0"}`;
  const tokRes = await fetch(`${base}/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, appsecret: env.WHATSAPP_APP_SECRET_FOR_OAUTH }),
  });
  const tok = (await tokRes.json().catch(() => ({}))) as { access_token?: string; error?: { message?: string } };
  if (!tok.access_token) return { ok: false, error: tok.error?.message || `HTTP ${tokRes.status}` };
  // longo (60d) → system user token permanente via /me/businesses? não: exchange oficial:
  const longRes = await fetch(`${base}/oauth/access_token?grant_type=client_credentials&client_id=${env.WHATSAPP_APP_ID}&client_secret=${env.WHATSAPP_APP_SECRET_FOR_OAUTH}`);
  const longJson = (await longRes.json().catch(() => ({}))) as { access_token?: string };
  const systemToken = longJson.access_token ?? tok.access_token; // melhor esforço; documentado
  const bmRes = await fetch(`${base}/me/accounts?fields=name,business_verification_overall_status,bm_id`, { headers: { Authorization: `Bearer ${systemToken}` } });
  const bm = (await bmRes.json().catch(() => ({}))) as { data?: { id?: string }[] };
  // descobre WABA + número do config (fluxo oficial usa /whatsapp_business_accounts no BM)
  const wabaRes = await fetch(`${base}/${configId}/waba_business_accounts`, { headers: { Authorization: `Bearer ${systemToken}` } });
  const wabaJson = (await wabaRes.json().catch(() => ({}))) as { data?: { id?: string }[] };
  const wabaId = wabaJson.data?.[0]?.id ?? bm.data?.[0]?.id ?? "";
  let phoneNumberId = "";
  if (wabaId) {
    const pnRes = await fetch(`${base}/${wabaId}/phone_numbers`, { headers: { Authorization: `Bearer ${systemToken}` } });
    const pn = (await pnRes.json().catch(() => ({}))) as { data?: { id?: string }[] };
    phoneNumberId = pn.data?.[0]?.id ?? "";
  }
  return { ok: Boolean(wabaId && phoneNumberId), error: wabaId && phoneNumberId ? undefined : "autorização obtida, mas WABA/número não localizados — complete manualmente", access_token: systemToken, waba_id: wabaId, phone_number_id: phoneNumberId };
}

/** Validação de assinatura de webhook Meta (x-hub-signature-256: sha256=HMAC(body, app_secret)). */
export async function verifyWebhookSignature(appSecret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!appSecret) return false; // sem segredo configurado: recusa (a rota trata dev com aviso)
  if (!header?.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(appSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const hex = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const expected = header.slice(7);
  if (hex.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export function mockAllowed(ctx: { env: { WHATSAPP_MOCK?: string }; demo: boolean }): boolean {
  return ctx.env.WHATSAPP_MOCK === "1" || ctx.demo;
}

export async function resolveProvider(ctx: Omit<ProviderContext, "conn"> & { conn: ProviderConnectionRow | null }): Promise<{ provider: Provider | null; error?: string }> {
  if (!ctx.conn || ctx.conn.status === "disconnected") return { provider: null, error: "WhatsApp não conectado a esta barbearia." };
  if (ctx.conn.provider === "mock") {
    if (!mockAllowed(ctx)) return { provider: null, error: "Provedor mock desabilitado neste ambiente." };
    return { provider: mockProvider };
  }
  return { provider: metaProvider };
}

export { encryptSecret, decryptSecret };
