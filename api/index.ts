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
import { expirePendingTopups } from "./lib/topup";
import { nowIso } from "./lib/utils";

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
    whatsapp: { embedded: Boolean(c.env.WHATSAPP_APP_ID && c.env.WHATSAPP_EMBEDDED_CONFIG_ID), mock: c.env.WHATSAPP_MOCK === "1" },
    payments: { mercadopago: Boolean(c.env.MP_ACCESS_TOKEN), mock: c.env.PAYMENTS_MOCK === "1" },
  })
);

app.use("/api/*", originGuard);

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
    ctx.waitUntil(
      (async () => {
        try {
          await processDueJobs(env, { limit: 40 });
          await expirePendingTopups(env);
        } catch (e) {
          console.error("[cron]", String(e));
        }
      })()
    );
  },
};

export { app };
export const fetchHandler = (request: Request, env: Env, ctx: ExecutionContext) => app.fetch(request, env, ctx);
