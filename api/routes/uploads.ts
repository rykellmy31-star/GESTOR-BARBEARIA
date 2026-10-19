// GET /uploads/* — serve R2 privado (não expõe o bucket). Upload é feito pelo
// painel via POST /api/c/:slug/admin/upload.
import { Hono } from "hono";
import type { Env } from "../types";
import { err } from "../lib/utils";

export const uploadsRouter = new Hono<{ Bindings: Env }>();
uploadsRouter.all("/*", async (c) => {
  if (c.req.method !== "GET") return err(c, "Método não permitido", 405);
  if (!c.env.MEDIA) return err(c, "R2 não configurado", 501);
  const key = new URL(c.req.url).pathname.replace(/^\/uploads\//, "");
  if (!/^img\/[a-z0-9\/.\-]+$/.test(key)) return err(c, "Chave inválida", 400);
  const obj = await c.env.MEDIA.get(key);
  if (!obj) return err(c, "Não encontrado", 404);
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "public, max-age=31536000, immutable",
      etag: `"${obj.etag}"`,
    },
  });
});
