/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import { hasImageSignature, MAX_IMAGE_BYTES, MAX_UPLOAD_BYTES, readUploadBody } from "../api/lib/image-upload";
import type { Env } from "../api/types";

const db = env.DB as D1Database;
const e = { ...env, APP_ENV: "development", SESSION_SECRET: "upload-test-secret-at-least-32-characters" } as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uoAAAAASUVORK5CYII="), c => c.charCodeAt(0));
let slug: string, cookie: string;
beforeAll(async () => {
  for (const sql of schema.replace(/--[^\n]*/g, "").split(";").map(s => s.trim()).filter(Boolean)) await db.prepare(sql).run();
  slug = `upload-${crypto.randomUUID()}`;
  const company = Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Fotos')").bind(slug).run()).meta.last_row_id);
  const user = Number((await db.prepare("INSERT INTO users(name,email,password_hash) VALUES ('Dono',?1,'unused')").bind(`${slug}@tigu.test`).run()).meta.last_row_id);
  const token = crypto.randomUUID();
  await db.batch([
    db.prepare("INSERT INTO company_memberships(company_id,user_id,role) VALUES (?1,?2,'owner')").bind(company,user),
    db.prepare("INSERT INTO subscriptions(company_id,plan_code,status,period_end) VALUES (?1,'free','active',?2)").bind(company,new Date(Date.now()+86400000).toISOString()),
    db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,?3)").bind(await sha256hex(`${token}:${e.SESSION_SECRET}:${user}`),user,new Date(Date.now()+86400000).toISOString()),
  ]);
  cookie = `aurum_session=uid.${user}.${token}`;
});
function upload(bytes: Uint8Array, type = "image/png", authenticated = true) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), "foto.png");
  return app.request(`http://localhost/api/c/${slug}/admin/upload`, {
    method: "POST", headers: { host: "localhost", origin: "http://localhost", ...(authenticated ? { cookie } : {}) }, body: form,
  }, e, ctx);
}

describe("upload e entrega de imagens", () => {
  it("salva PNG autenticado no R2 local e serve bytes com proteção contra interpretação ativa", async () => {
    const response = await upload(png);
    expect(response.status).toBe(201);
    const { url } = await response.json() as { url: string };
    expect(url).toMatch(/^\/uploads\/img\/c\d+\/[a-f0-9-]+\.png$/);
    const image = await app.request(url, {}, e, ctx);
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
    expect(image.headers.get("x-content-type-options")).toBe("nosniff");
    expect(image.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(png);
  });
  it("recusa HTML renomeado, assinatura divergente, arquivo vazio e SVG sem salvar objetos", async () => {
    const before = (await e.MEDIA!.list()).objects.length;
    for (const [bytes,type] of [[new TextEncoder().encode("<script>alert(1)</script>"),"image/png"], [png,"image/jpeg"], [new Uint8Array(),"image/png"], [png,"image/svg+xml"]] as const)
      expect((await upload(bytes,type)).status).toBe(415);
    expect((await e.MEDIA!.list()).objects.length).toBe(before);
  });
  it("exige sessão antes de aceitar arquivo", async () => {
    expect((await upload(png,"image/png",false)).status).toBe(401);
  });
  it("recusa imagem acima de 5 MiB e corpo multipart acima do limite total", async () => {
    expect((await upload(new Uint8Array(MAX_IMAGE_BYTES+1))).status).toBe(413);
    expect((await upload(new Uint8Array(MAX_UPLOAD_BYTES+1))).status).toBe(413);
  });
  it("neutraliza tipo ativo legado vindo dos metadados do R2", async () => {
    const key = `img/legacy-${crypto.randomUUID()}.png`;
    await e.MEDIA!.put(key,"<script>alert(1)</script>",{httpMetadata:{contentType:"text/html"}});
    const response = await app.request(`/uploads/${key}`,{},e,ctx);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
  });
});

describe("leitura limitada e assinaturas", () => {
  it("conta bytes reais e cancela stream sem confiar em Content-Length", async () => {
    for (const headers of [new Headers(), new Headers({ "content-length": "1" })]) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) { controller.enqueue(new Uint8Array(1024*1024)); },
        cancel() { cancelled = true; },
      });
      expect(await readUploadBody(new Request("https://tigu.test", {method:"POST",headers,body}))).toBeNull();
      expect(cancelled).toBe(true);
    }
  });
  it("reconhece JPEG, WebP e marcas AVIF compatíveis sem aceitar marca fora do ftyp", () => {
    expect(hasImageSignature(new Uint8Array([255,216,255,224]),"image/jpeg")).toBe(true);
    const webp = new Uint8Array(20);
    webp.set(new TextEncoder().encode("RIFF"));
    webp.set(new TextEncoder().encode("WEBPVP8L"),8);
    expect(hasImageSignature(webp,"image/webp")).toBe(true);
    const avif = new Uint8Array(24);
    new DataView(avif.buffer).setUint32(0,20);
    avif.set(new TextEncoder().encode("ftypmif1"),4);
    avif.set(new TextEncoder().encode("avif"),16);
    expect(hasImageSignature(avif,"image/avif")).toBe(true);
    new DataView(avif.buffer).setUint32(0,16);
    expect(hasImageSignature(avif,"image/avif")).toBe(false);
    new DataView(avif.buffer).setUint32(0,28);
    expect(hasImageSignature(avif,"image/avif")).toBe(false);
  });
});
