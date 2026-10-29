// Evolution API v2 (Baileys). Chave global permanece somente nos secrets do Worker.
// Instâncias são isoladas por company_id; nenhuma URL/chave é enviada pelo navegador.
import type { Provider, ProviderContext, SendTemplateInput, SendTemplateResult } from "./provider";

export interface EvolutionRow {
  company_id: number;
  instance_name: string;
  status: string;
  enabled: number;
  display_phone: string;
  last_error: string;
  connected_at: string | null;
  updated_at: string;
}

export interface EvolutionEnv {
  EVOLUTION_API_URL?: string;
  EVOLUTION_API_KEY?: string;
  EVOLUTION_WEBHOOK_SECRET?: string;
  PUBLIC_URL?: string;
  TIGU_STAGING?: string;
}

export function evolutionReady(env: EvolutionEnv): boolean {
  if (!env.EVOLUTION_API_URL || !env.EVOLUTION_API_KEY || !env.EVOLUTION_WEBHOOK_SECRET || !env.PUBLIC_URL) return false;
  try {
    const api = new URL(env.EVOLUTION_API_URL);
    const publicUrl = new URL(env.PUBLIC_URL);
    return api.protocol === "https:" && publicUrl.protocol === "https:" && !!api.hostname && !!publicUrl.hostname;
  } catch { return false; }
}

export function evolutionInstanceName(companyId: number): string {
  if (!Number.isSafeInteger(companyId) || companyId < 1) throw new Error("Empresa inválida");
  return `tigu-company-${companyId}`;
}

export async function evolutionRequest(
  env: EvolutionEnv,
  method: "GET" | "POST" | "DELETE",
  route: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: any }> {
  if (!evolutionReady(env) || env.TIGU_STAGING === "1") return { ok: false, status: 503, data: { error: "Evolution API não configurada ou indisponível neste ambiente." } };
  if (!/^\/(?:instance|message|webhook)\/[a-zA-Z0-9/_-]+$/.test(route)) throw new Error("Rota Evolution inválida");
  const api = new URL(env.EVOLUTION_API_URL!);
  if (api.pathname !== "/" && api.pathname !== "") throw new Error("EVOLUTION_API_URL deve ser a origem HTTPS, sem caminho");
  try {
    const response = await fetch(`${api.origin}${route}`, {
      method,
      headers: { apikey: env.EVOLUTION_API_KEY!, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, status: response.status, data };
  } catch {
    return { ok: false, status: 503, data: { error: "Evolution API não respondeu (rede/timeout)." } };
  }
}

export function evolutionState(data: any): string {
  const state = data?.instance?.state ?? data?.instance?.status ?? data?.state;
  return String(state || "").toLowerCase() === "open" ? "connected" : "pending_setup";
}

export function evolutionQR(data: any): string | null {
  const raw = data?.base64 ?? data?.qrcode?.base64 ?? data?.qrcode?.image ?? null;
  if (typeof raw !== "string") return null;
  if (/^data:image\/(png|jpeg);base64,[a-z0-9+/=\s]+$/i.test(raw)) return raw;
  // Aceitar apenas PNG real, não SVG/HTML controlado remotamente.
  if (/^iVBORw0KGgo[a-z0-9+/=\s]*$/i.test(raw) && raw.length < 200000) return `data:image/png;base64,${raw}`;
  return null;
}

export function renderEvolutionText(body: string, variables: { key: string; sample: string }[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => {
    const found = variables.find((v) => v.key === `{{${index}}}`);
    return found?.sample ?? "";
  }).slice(0, 1800);
}

export async function getEvolutionRow(db: D1Database, companyId: number): Promise<EvolutionRow | null> {
  return db.prepare("SELECT company_id,instance_name,status,enabled,display_phone,last_error,connected_at,updated_at FROM evolution_connections WHERE company_id=?1")
    .bind(companyId).first<EvolutionRow>();
}

export const evolutionProvider: Provider = {
  kind: "evolution",
  async status(ctx) {
    const response = await evolutionRequest(ctx.env, "GET", `/instance/connectionState/${ctx.conn.phone_number_id}`);
    if (!response.ok) return { ok: false, error: "Não foi possível consultar o WhatsApp na Evolution API." };
    const ok = evolutionState(response.data) === "connected";
    return { ok, error: ok ? undefined : "Aguardando leitura do QR Code no WhatsApp.", display_phone: ctx.conn.display_phone };
  },
  async sendTemplate(ctx: ProviderContext, input: SendTemplateInput): Promise<SendTemplateResult> {
    const tpl = await ctx.db.prepare(
      "SELECT body_text FROM whatsapp_templates WHERE company_id=?1 AND code=?2 AND language=?3 AND active=1"
    ).bind(ctx.conn.company_id,input.templateCode,input.language).first<{ body_text: string }>();
    if (!tpl?.body_text) return { accepted: false, permanent: true, error: "Modelo de mensagem não configurado." };
    const text = renderEvolutionText(tpl.body_text, input.variables);
    if (!text.trim()) return { accepted: false, permanent: true, error: "Modelo sem texto." };
    const response = await evolutionRequest(ctx.env, "POST", `/message/sendText/${ctx.conn.phone_number_id}`, { number: input.to, text });
    const key = response.data?.key?.id ?? response.data?.message?.key?.id;
    if (response.ok && typeof key === "string" && key.length > 0)
      return { accepted: true, permanent: false, providerMessageId: key, providerCostCents: 0 };
    const uncertain = response.ok || response.status >= 500;
    return { accepted: false, permanent: !uncertain && response.status !== 429, uncertain,
      error: response.ok ? "Resposta sem confirmação de ID da mensagem." : `Falha no envio Evolution (HTTP ${response.status})` };
  },
  async listTemplates(ctx) {
    const rows = await ctx.db.prepare("SELECT code,language,category,status,body_text FROM whatsapp_templates WHERE company_id=?1 AND active=1")
      .bind(ctx.conn.company_id).all<{code:string;language:string;category:string;status:string;body_text:string}>();
    return { ok: true, templates: rows.results.map((t) => ({
      code: t.code, name: t.code, language: t.language, category: t.category, status: "APPROVED", body_preview: t.body_text,
    })) };
  },
  async disconnect(ctx) {
    const name = ctx.conn.phone_number_id;
    const result = await evolutionRequest(ctx.env, "DELETE", `/instance/logout/${name}`);
    // Algumas versões implementam logout via DELETE, outras via GET.
    if (!result.ok) {
      const fallback = await evolutionRequest(ctx.env, "GET", `/instance/logout/${name}`);
      if (!fallback.ok) throw new Error("Não foi possível sair da sessão Evolution; tente novamente.");
    }
    await ctx.db.prepare("UPDATE evolution_connections SET enabled=0,status='disconnected',updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE company_id=?1")
      .bind(ctx.conn.company_id).run();
  },
};
