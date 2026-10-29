// Rotas de gestão da Evolution API: administradores autenticados via adminRouter.
// Nunca aceitar base URL, apikey ou instanceName do navegador.
import { Hono } from "hono";
import type { Env } from "../types";
import { cid } from "../lib/tenant";
import { err, json, nowIso } from "../lib/utils";
import { audit } from "../lib/audit";
import { evolutionInstanceName, evolutionReady, evolutionRequest, evolutionQR, evolutionState, getEvolutionRow } from "../lib/messaging/evolution";

export const evolutionRouter = new Hono<{ Bindings: Env }>();

evolutionRouter.get("/status", async (c) => {
  const db = c.env.DB;
  const companyId = cid(c);
  const row = await getEvolutionRow(db, companyId);
  const configured = evolutionReady(c.env) && c.env.TIGU_STAGING !== "1";
  if (!row || row.enabled !== 1 || !configured) return json(c, {
    configured, active: row?.enabled === 1, status: row?.status ?? "disconnected",
    instance: row?.enabled ? row.instance_name : null, reason: configured ? null : "Servidor da Evolution API ainda não configurado.",
  });
  // Consulta real: QR lido em outro dispositivo só é confirmado pela API, não pela interface.
  const remote = await evolutionRequest(c.env, "GET", `/instance/connectionState/${row.instance_name}`);
  const status = remote.ok ? evolutionState(remote.data) : "error";
  const error = remote.ok ? "" : "Evolution API indisponível ou sessão não encontrada.";
  // GET permanece realmente somente leitura (inclusive em modo suporte Super Admin).
  // O webhook autenticado atualiza o D1. A resposta mostra o estado remoto atual.
  return json(c, { configured, active: true, status, instance: row.instance_name, error });
});

evolutionRouter.post("/start", async (c) => {
  if (!evolutionReady(c.env) || c.env.TIGU_STAGING === "1")
    return err(c, "Evolution API ainda não instalada/configurada. A conexão real só será habilitada depois.", 503);
  const db = c.env.DB, companyId = cid(c);
  const old = await db.prepare("SELECT status,provider FROM whatsapp_connections WHERE company_id=?1")
    .bind(companyId).first<{status:string;provider:string}>();
  if (old?.status === "connected") return err(c, "Desconecte primeiro a integração WhatsApp existente para evitar conflitos.", 409);
  // Não converter silenciosamente jobs cobrados pela integração anterior.
  const charged = await db.prepare(`SELECT COUNT(*) n FROM message_jobs
    WHERE company_id=?1 AND status IN ('scheduled','blocked_funds') AND price_cents>0`).bind(companyId).first<{n:number}>();
  if (charged && charged.n>0) return err(c, "Há mensagens antigas com créditos na fila. Finalize ou cancele esses envios antes de trocar o provedor.", 409);
  const instance = evolutionInstanceName(companyId);
  const saved = await getEvolutionRow(db, companyId);
  if (saved && saved.instance_name !== instance) return err(c,"Instância da empresa inconsistente.",409);

  // Instância idempotente: uma tentativa anterior pode ter criado a sessão antes do timeout.
  const check = await evolutionRequest(c.env, "GET", `/instance/connectionState/${instance}`);
  if (!check.ok && check.status !== 404) return err(c, "Não foi possível consultar a Evolution API.", 502);
  let firstQR: string | null = null;
  if (check.status === 404) {
    const created = await evolutionRequest(c.env, "POST", "/instance/create",
      { instanceName: instance, integration: "WHATSAPP-BAILEYS", qrcode: true,
        rejectCall: false, groupsIgnore: true, readMessages: false, readStatus: false,
        syncFullHistory: false });
    if (!created.ok) return err(c, `Evolution API recusou a criação (HTTP ${created.status}).`, 502);
    firstQR = evolutionQR(created.data);
  }

  const callback = new URL("/api/webhooks/evolution/", c.env.PUBLIC_URL).toString();
  const hooked = await evolutionRequest(c.env, "POST", `/webhook/set/${instance}`, {
    webhook: {
      enabled: true, url: callback, byEvents: false, base64: false,
      headers: { "x-tigu-webhook-token": c.env.EVOLUTION_WEBHOOK_SECRET },
      events: ["CONNECTION_UPDATE","MESSAGES_UPSERT","MESSAGES_UPDATE"],
    },
  });
  if (!hooked.ok) return err(c, `A instância existe, mas o webhook seguro não pôde ser configurado (HTTP ${hooked.status}).`, 502);

  await db.prepare(`INSERT INTO evolution_connections
      (company_id,instance_name,status,enabled,last_error,updated_at) VALUES (?1,?2,'pending_setup',1,'',?3)
      ON CONFLICT(company_id) DO UPDATE SET enabled=1,status='pending_setup',last_error='',updated_at=?3`)
    .bind(companyId,instance,nowIso()).run();

  // Modelos locais para mensagens livres no canal Evolution; não dependem de aprovação Meta.
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO whatsapp_templates
      (company_id,code,language,category,status,body_text,use_case)
      VALUES (?1,'tigu_confirmacao','pt_BR','utility','approved',
      'Olá {{1}}! Seu agendamento foi registrado. Nos vemos em breve!','confirmation')`).bind(companyId),
    db.prepare(`INSERT OR IGNORE INTO whatsapp_templates
      (company_id,code,language,category,status,body_text,use_case)
      VALUES (?1,'tigu_lembrete','pt_BR','utility','approved',
      'Olá {{1}}! Passando para lembrar do seu horário na barbearia.','reminder')`).bind(companyId),
  ]);
  await audit(db, c.get("user"), "whatsapp.evolution.start", "evolution_connection", companyId, {}, { companyId });
  return json(c, { ok: true, status: "pending_setup", qr: firstQR });
});

evolutionRouter.post("/qr", async (c) => {
  if (!evolutionReady(c.env) || c.env.TIGU_STAGING === "1") return err(c,"Evolution API indisponível.",503);
  const row = await getEvolutionRow(c.env.DB,cid(c));
  if (!row || row.enabled!==1) return err(c,"Inicie a integração primeiro.",404);
  const res = await evolutionRequest(c.env,"GET",`/instance/connect/${row.instance_name}`);
  if (!res.ok) return err(c,"Não foi possível obter o QR Code. Verifique a sessão.",502);
  const qr = evolutionQR(res.data);
  const status = evolutionState(res.data);
  return json(c,{ok:true,qr,status,message:qr?null:"A API não retornou imagem de QR Code; tente gerar novamente."});
});

evolutionRouter.post("/disconnect", async (c) => {
  const row = await getEvolutionRow(c.env.DB,cid(c));
  if (!row || row.enabled!==1) return err(c,"Evolution não está ativa.",404);
  const res = await evolutionRequest(c.env,"DELETE",`/instance/logout/${row.instance_name}`);
  const fallback = res.ok ? res : await evolutionRequest(c.env,"GET",`/instance/logout/${row.instance_name}`);
  if (!fallback.ok) return err(c,"Não foi possível desconectar na Evolution. Não alteramos sua conexão local.",502);
  await c.env.DB.prepare(`UPDATE evolution_connections SET enabled=0,status='disconnected',updated_at=?1 WHERE company_id=?2`)
    .bind(nowIso(),cid(c)).run();
  await audit(c.env.DB,c.get("user"),"whatsapp.evolution.disconnect","evolution_connection",cid(c),{}, {companyId:cid(c)});
  return json(c,{ok:true});
});
