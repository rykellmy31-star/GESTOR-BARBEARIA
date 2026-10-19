// ============================================================================
// TIGU — Worker (Hono) + cron de mensagens.
// Rotas:
//   /api/auth/*            login global, onboarding, recuperação
//   /api/c/:slug/*         público (site, agendamento, loja)
//   /api/c/:slug/admin/*   painel da barbearia (owner/manager)
//   /api/c/:slug/painel/*  painel do barbeiro
//   /api/super/*           suíte Tigu (superadmin)
//   /api/webhooks/*        Meta + Mercado Pago (sem sessão)
//   /uploads/*             R2 privado
//   scheduled(ev,env,ctx)  cron ~1min → fila de mensagens + expiração topups
// ============================================================================
import { Hono } from "hono";
import type { Env } from "./types";
import { authRouter } from "./routes/auth";
import { publicRouter } from "./routes/public";
import { adminRouter } from "./routes/admin";
import { barberRouter } from "./routes/barber";
import { superRouter } from "./routes/super";
import { webhooksRouter } from "./routes/webhooks";
import { uploadsRouter } from "./routes/uploads";
import { originGuard } from "./lib/auth";
import { processDueJobs } from "./lib/messaging/jobs";
import { expirePendingTopups, reconcilePendingTopups } from "./lib/topup";
import { nowIso } from "./lib/utils";
import { loadSalesContact, publicSalesContact } from "./lib/marketing";
import { listPublicPlans } from "./lib/plans";
import { allowSalesLeadAttempt, createSalesLead, leadRequestSchema } from "./lib/sales-leads";
import { salesChallengeConfig, verifySalesTurnstile } from "./lib/sales-challenge";

const app = new Hono<{ Bindings: Env }>();

app.onError((e, c) => {
  const msg = e instanceof Error ? e.message : String(e);
  console.error(`[api-error] ${c.req.method} ${c.req.path}:`, msg, (e as Error).stack ?? "");
  return c.json({ error: "Erro interno. Migrations aplicadas? (npm run db:migrate:local)", detail: c.env.APP_ENV !== "production" ? msg : undefined }, 500);
});
app.notFound((c) => c.json({ error: "Rota não encontrada", path: c.req.path }, 404));

app.get("/api/health", (c) =>
  c.json({
    ok: true,
    service: "tigu-api",
    time: nowIso(),
    d1: Boolean(c.env.DB),
    r2: Boolean(c.env.MEDIA),
    staging: c.env.TIGU_STAGING === "1",
    security: {
      session_secret_ready: Boolean(c.env.SESSION_SECRET && c.env.SESSION_SECRET.length >= 32),
      encryption_key_ready: Boolean(c.env.MSG_ENC_KEY && c.env.MSG_ENC_KEY.length >= 32),
    },
    whatsapp: { embedded: Boolean(c.env.WHATSAPP_APP_ID && c.env.WHATSAPP_EMBEDDED_CONFIG_ID), mock: c.env.WHATSAPP_MOCK === "1" },
    payments: { mercadopago: Boolean(c.env.MP_ACCESS_TOKEN), mock: c.env.PAYMENTS_MOCK === "1" },
  })
);

/** Página comercial pública (sem expor contatos desativados). */
app.get("/api/marketing/contact", async (c) =>
  c.json({ contact: publicSalesContact(await loadSalesContact(c.env.DB)) })
);

/** Preços e limites da página de contratação vêm do D1, não do bundle React. */
app.get("/api/marketing/plans", async (c) =>
  c.json({ plans: await listPublicPlans(c.env.DB), automatic_billing: false })
);

/** Configuração pública da proteção; nunca retorna a chave secreta. */
app.get("/api/marketing/lead-config", (c) =>
  c.json(salesChallengeConfig(c.env))
);

app.use("/api/*", originGuard);

/** Solicitação de atendimento para planos pagos: nunca cria cobrança nem ativa assinatura. */
app.post("/api/marketing/leads", async (c) => {
  const parsed = leadRequestSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Confira seus dados e aceite o contato comercial.", details: parsed.error.flatten().fieldErrors }, 422);
  if (parsed.data.website) return c.json({ ok: true, message: "Solicitação recebida." }, 201);
  const key = c.env.SESSION_SECRET || (c.env.APP_ENV === "production" ? "" : "dev-only-lead-key");
  if (!key) return c.json({ error: "Atendimento indisponível temporariamente." }, 503);
  const visitorIp = c.req.header("cf-connecting-ip") || null;
  const challenge = await verifySalesTurnstile(c.env, parsed.data.turnstile_token, visitorIp);
  if (challenge === "missing_config") return c.json({ error: "Formulário temporariamente indisponível: proteção antirobôs não configurada." }, 503);
  if (challenge !== "ok") return c.json({ error: "Confirme a verificação de segurança e tente novamente." }, 422);
  const allowed = await allowSalesLeadAttempt(c.env.DB,key,visitorIp,parsed.data.email);
  if (!allowed) return c.json({ error: "Limite de solicitações atingido. Tente novamente mais tarde." }, 429);
  const result = await createSalesLead(c.env.DB, parsed.data);
  if (result.status === "missing_plan") return c.json({ error: "O plano selecionado está indisponível." }, 422);
  if (result.status === "duplicate") return c.json({ error: "Já recebemos uma solicitação recente para esse plano. Aguarde nosso contato." }, 409);
  return c.json({ ok: true, reference: result.id, message: "Solicitação registrada. Nossa equipe poderá entrar em contato." }, 201);
});


app.route("/api/auth", authRouter);
app.route("/api/super", superRouter);
app.route("/api/webhooks", webhooksRouter);
app.route("/api/c/:slug/admin", adminRouter);
app.route("/api/c/:slug/painel", barberRouter);
app.route("/api/c/:slug/barber", barberRouter); // alias p/ o app do painel do profissional
app.route("/api/c/:slug", publicRouter);
app.route("/uploads", uploadsRouter);

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx),

  /** Cron (wrangler [triggers] crons): dispara lembretes/confirmações. */
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    if (env.TIGU_STAGING === "1") return; // Nenhum disparo agendado na homologação.
    ctx.waitUntil(
      (async () => {
        try {
          await processDueJobs(env, { limit: 40 });
          await expirePendingTopups(env);
          // Reconsulta apenas a cada 10 minutos, evitando custo excessivo
          // e recuperando pagamentos aprovados que perderam o webhook.
          if (new Date().getUTCMinutes() % 10 === 0) {
            await reconcilePendingTopups(env, 20);
          }
        } catch (e) {
          console.error("[cron]", String(e));
        }
      })()
    );
  },
};

export { app };
export const fetchHandler = (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx);
