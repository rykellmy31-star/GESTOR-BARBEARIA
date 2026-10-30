// TIGU — a Evolution API é o ÚNICO provedor externo WhatsApp.
// O mock abaixo existe apenas para testes/demonstrações locais e nunca
// acessa a rede. Integração Meta/Graph/Embedded Signup removida.
// Tabelas legadas permanecem no D1 exclusivamente para auditoria histórica.
import { sha256hex } from "../crypto";
import { evolutionProvider } from "./evolution";

export interface ProviderConnectionRow {
  id: number;
  company_id: number;
  provider: "evolution" | "mock";
  waba_id: string; // campo legado da estrutura DB; nunca usado para envio
  phone_number_id: string; // nome da instância Evolution, não ID da Meta
  display_phone: string;
  business_name: string;
  status: "disconnected" | "pending_setup" | "connected" | "error";
  access_token_enc: string; // campo legado, nunca usado para enviar
  coexistence: "unknown" | "enabled" | "not_eligible"; // histórico legado
  last_error: string;
  last_check_at: string | null;
  connected_at: string | null;
  demo: number;
}
export interface ProviderContext {
  env: { APP_ENV?: string; TIGU_STAGING?: string; WHATSAPP_MOCK?: string;
    EVOLUTION_API_URL?: string; EVOLUTION_API_KEY?: string;
    EVOLUTION_WEBHOOK_SECRET?: string; PUBLIC_URL?: string };
  db: D1Database;
  conn: ProviderConnectionRow;
  demo: boolean;
}
export interface TemplateVariable { key: string; sample: string; }
export interface SendTemplateInput {
  to: string;
  templateCode: string;
  language: string;
  variables: TemplateVariable[];
  wabaBizMetadata?: Record<string, string>; // chave interna compatível da fila
}
export interface SendTemplateResult {
  accepted: boolean;
  providerMessageId?: string;
  permanent: boolean;
  uncertain?: boolean;
  error?: string;
  providerCostCents?: number;
}
export interface ProviderTemplateInfo {
  code: string; name: string; language: string;
  category: string; status: string; body_preview?: string;
}
export interface Provider {
  kind: "evolution" | "mock";
  status(ctx: ProviderContext): Promise<{ ok: boolean; error?: string; display_phone?: string; quality_rating?: string; verified_name?: string }>;
  sendTemplate(ctx: ProviderContext, input: SendTemplateInput): Promise<SendTemplateResult>;
  listTemplates(ctx: ProviderContext): Promise<{ ok: boolean; error?: string; templates?: ProviderTemplateInfo[] }>;
  disconnect(ctx: ProviderContext): Promise<void>;
}

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


export function mockAllowed(ctx: { env: { WHATSAPP_MOCK?: string }; demo: boolean }): boolean {
  return ctx.env.WHATSAPP_MOCK === "1" || ctx.demo;
}

/** Nunca faz fallback para a Meta, mesmo quando existem credenciais antigas no banco. */
export async function resolveProvider(ctx: Omit<ProviderContext, "conn"> & {
  conn: ProviderConnectionRow | null
}): Promise<{provider: Provider | null; error?: string}> {
  if (!ctx.conn || ctx.conn.status === "disconnected")
    return {provider:null,error:"Evolution API não conectada a esta barbearia."};
  if (ctx.conn.provider === "mock") {
    if (!mockAllowed(ctx)) return {provider:null,error:"Simulação desabilitada."};
    return {provider:mockProvider};
  }
  if (ctx.conn.provider !== "evolution")
    return {provider:null,error:"Provedor WhatsApp antigo não suportado."};
  if (ctx.env.TIGU_STAGING === "1")
    return {provider:null,error:"Evolution real desativada enquanto o TIGU estiver em homologação."};
  return {provider:evolutionProvider};
}
