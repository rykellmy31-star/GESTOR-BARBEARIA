import { bufToB64, b64ToBuf, randomHex } from "./utils";
import { pbkdf2 as nodePbkdf2 } from "node:crypto";

// PBKDF2-SHA256: WebCrypto do Workers limita a derivação a até 100 mil iterações.
// Hashes legados com 150 mil continuam verificáveis via node:crypto (nodejs_compat).
// Formato armazenado: pbkdf2_sha256$<iterações>$<salt b64>$<hash b64>
const ITERATIONS = 100_000;
const MAX_STORED_ITERATIONS = 1_000_000;

const enc = new TextEncoder();

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > MAX_STORED_ITERATIONS)
    throw new Error("Parâmetros PBKDF2 fora do intervalo permitido");
  if (iterations > ITERATIONS) {
    // Compatibilidade com hashes históricos produzidos antes da correção;
    // o formato salvo inclui o número de iterações de cada credencial.
    const derived = await new Promise<Uint8Array>((resolve, reject) => {
      nodePbkdf2(password, Buffer.from(salt), iterations, 32, "sha256", (error, value) => {
        if (error) reject(error);
        else resolve(Uint8Array.from(value));
      });
    });
    return derived.buffer;
  }
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  return crypto.subtle.deriveBits({ name: "PBKDF2", salt: salt as unknown as BufferSource, iterations, hash: "SHA-256" }, key, 256);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  return `pbkdf2_sha256$${ITERATIONS}$${bufToB64(salt)}$${bufToB64(hash)}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const [algo, itersStr, saltB64, hashB64] = stored.split("$");
    if (algo !== "pbkdf2_sha256") return false;
    const iterations = parseInt(itersStr, 10);
    if (!Number.isFinite(iterations) || iterations <= 0) return false;
    const salt = b64ToBuf(saltB64);
    const expected = b64ToBuf(hashB64);
    const actual = new Uint8Array(await derive(password, salt, iterations));
    if (actual.length !== expected.length) return false;
    // comparação em tempo constante
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function newSessionToken(): string {
  return randomHex(32);
}

// ── Cifra autenticada (AES-256-GCM) p/ tokens de API em repouso no D1 ─────
// A chave deriva de MSG_ENC_KEY (secreto). Formato armazenado: v1.<b64iv>.<b64ct+tag>
async function encKey(env: { MSG_ENC_KEY?: string; SESSION_SECRET?: string; APP_ENV?: string }): Promise<CryptoKey> {
  const secret = env.MSG_ENC_KEY || (env.APP_ENV === "production" ? "" : "tigu-dev-enc-key-nao-use-em-producao") || env.SESSION_SECRET || "";
  if (!secret) throw new Error("MSG_ENC_KEY não configurada (npx wrangler secret put MSG_ENC_KEY)");
  const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", salt: new TextEncoder().encode("tigu.secret.v1"), iterations: 100_000, hash: "SHA-256" }, material, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(env: { MSG_ENC_KEY?: string; SESSION_SECRET?: string; APP_ENV?: string }, plaintext: string): Promise<string> {
  if (!plaintext) return "";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encKey(env), enc.encode(plaintext));
  return `v1.${bufToB64(iv)}.${bufToB64(ct)}`;
}

export async function decryptSecret(env: { MSG_ENC_KEY?: string; SESSION_SECRET?: string; APP_ENV?: string }, stored: string): Promise<string> {
  if (!stored) return "";
  try {
    const [v, ivB64, ctB64] = stored.split(".");
    if (v !== "v1" || !ivB64 || !ctB64) return "";
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64ToBuf(ivB64) as unknown as BufferSource }, await encKey(env), b64ToBuf(ctB64) as unknown as BufferSource);
    return new TextDecoder().decode(pt);
  } catch {
    return ""; // token ilegível (chave trocada?) — tratado como "desconectado" com aviso
  }
}
