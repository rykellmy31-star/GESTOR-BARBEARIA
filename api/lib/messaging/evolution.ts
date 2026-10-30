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
  TIGU_EVOLUTION_LIVE?: string;
}

/**
 * Diagnóstico sem valores, destinado somente ao painel autenticado do proprietário.
 * Nunca devolve URLs ou chaves ao navegador. Centraliza os mesmos requisitos de
 * segurança usados pelo Worker para autorizar criar instâncias e gerar QR.
 */
export function evolutionConfigurationProblem(env: EvolutionEnv): string | null {
  if (!env.EVOLUTION_API_URL?.trim()) return "Falta EVOLUTION_API_URL (variável do Worker).";
  if (!env.EVOLUTION_API_KEY?.trim()) return "Falta EVOLUTION_API_KEY (segredo do Worker).";
  if (!env.EVOLUTION_WEBHOOK_SECRET?.trim()) return "Falta EVOLUTION_WEBHOOK_SECRET (segredo do Worker).";
  if (env.EVOLUTION_WEBHOOK_SECRET.length < 32)
    return "EVOLUTION_WEBHOOK_SECRET está com menos de 32 caracteres; substitua por um segredo mais longo.";
  if (!env.PUBLIC_URL?.trim()) return "Falta PUBLIC_URL (variável do Worker).";
  try {
    const api = new URL(env.EVOLUTION_API_URL);
    const publicUrl = new URL(env.PUBLIC_URL);
    if (api.protocol !== "https:" || publicUrl.protocol !== "https:" ||
        !api.hostname || !publicUrl.hostname ||
        api.pathname !== "/" || publicUrl.pathname !== "/" ||
        api.username || api.password || api.search || api.hash ||
        publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash ||
        api.port || publicUrl.port) {
      return "EVOLUTION_API_URL ou PUBLIC_URL inválida: informe apenas a origem HTTPS.";
    }
  } catch {
    return "EVOLUTION_API_URL ou PUBLIC_URL inválida: informe apenas a origem HTTPS.";
  }
  if (env.TIGU_STAGING === "1" && env.TIGU_EVOLUTION_LIVE !== "1")
    return "TIGU_EVOLUTION_LIVE não está habilitada no Worker que atende o domínio oficial.";
  return null;
}

export function evolutionReady(env: EvolutionEnv): boolean {
  return evolutionConfigurationProblem({ ...env, TIGU_STAGING: "0" }) === null;
}

export function evolutionLiveAllowed(env: EvolutionEnv): boolean {
  return evolutionConfigurationProblem(env) === null;
}

export function evolutionInstanceName(companyId: number, companyName?: string): string {
  if (!Number.isSafeInteger(companyId) || companyId < 1) throw new Error("Empresa inválida");
  // Para uma instalação existente, o identificador anterior permanece válido.
  // Instâncias novas ficam legíveis no Evolution Manager e sempre incluem o ID
  // para garantir unicidade, mesmo com duas barbearias de mesmo nome.
  const slug = (companyName || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 45)
    .replace(/-+$/g, "");
  return slug ? `tigu-${slug}-c${companyId}` : `tigu-company-${companyId}`;
}

export async function evolutionRequest(
  env: EvolutionEnv,
  method: "GET" | "POST" | "DELETE",
  route: string,
  body?: unknown
): Promise<{ ok: boolean; status: number; data: any }> {
  if (!evolutionLiveAllowed(env)) return { ok: false, status: 503, data: { error: "Evolution API não configurada ou indisponível neste ambiente." } };
  if (!/^\/(?:instance|message|webhook)\/[a-zA-Z0-9/_-]+$/.test(route)) throw new Error("Rota Evolution inválida");
  const api = new URL(env.EVOLUTION_API_URL!);
  if (api.pathname !== "/" && api.pathname !== "") throw new Error("EVOLUTION_API_URL deve ser a origem HTTPS, sem caminho");
  try {
    const response = await fetch(`${api.origin}${route}`, {
      method,
      headers: { apikey: env.EVOLUTION_API_KEY!, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(12000),
      redirect: "manual", // Nunca encaminhar a chave global em redirecionamentos.
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

// A versão antiga continua em muitos cadastros. Atualizar apenas o texto
// original de fábrica (nunca sobrescrever uma mensagem personalizada).
export const LEGACY_TIGU_REMINDER = "Olá {{1}}! Passando para lembrar do seu horário na barbearia.";
export const DEFAULT_TIGU_REMINDER =
  "Olá {{1}}! 💈\n\nPassando para lembrar do seu horário na {{5}}, dia {{4}}.\nPedimos que chegue com 10 minutos de antecedência. Até breve!";

export function effectiveReminderText(code: string, body: string): string {
  return code === "tigu_lembrete" && body === LEGACY_TIGU_REMINDER
    ? DEFAULT_TIGU_REMINDER : body;
}

export function renderEvolutionText(body: string, variables: { key: string; sample: string }[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => {
    const found = variables.find((v) => v.key === index || v.key === `{{${index}}}`);
    return found?.sample ?? "";
  }).slice(0, 1800);
}

export async function getEvolutionRow(db: D1Database, companyId: number): Promise<EvolutionRow | null> {
  try {
    return await db.prepare("SELECT company_id,instance_name,status,enabled,display_phone,last_error,connected_at,updated_at FROM evolution_connections WHERE company_id=?1")
      .bind(companyId).first<EvolutionRow>();
  } catch (e) {
    // Compatibilidade com testes/bancos legados durante preparação da migração.
    if (String(e).includes("no such table: evolution_connections")) return null;
    throw e;
  }
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
    const text = renderEvolutionText(effectiveReminderText(input.templateCode, tpl.body_text), input.variables);
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
