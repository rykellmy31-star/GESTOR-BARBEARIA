/// <reference types="@cloudflare/vitest-plugin/types" />
import { describe, expect, it } from "vitest";
import { pbkdf2Sync } from "node:crypto";
import { hashPassword, verifyPassword } from "../api/lib/crypto";

describe("criptografia das senhas no runtime real de Workers", () => {
  it("cadastra e autentica senha PBKDF2 com 100 mil iterações suportadas", async () => {
    const password = "SenhaFicticia!2026-MuitoForte";
    const stored = await hashPassword(password);
    expect(stored).toMatch(/^pbkdf2_sha256\$100000\$/);
    expect(await verifyPassword(password,stored)).toBe(true);
    expect(await verifyPassword(password+"errada",stored)).toBe(false);
  });
  it("verifica hashes antigos de 150 mil iterações sem reduzir sua proteção", async () => {
    const password="LegadaSuperForte!2026";
    const salt=crypto.getRandomValues(new Uint8Array(16));
    const old=pbkdf2Sync(password,Buffer.from(salt),150_000,32,"sha256");
    const stored="pbkdf2_sha256$150000$"+Buffer.from(salt).toString("base64")+"$"+old.toString("base64");
    expect(await verifyPassword(password,stored)).toBe(true);
    expect(await verifyPassword(password+"incorreta",stored)).toBe(false);
  });
  it("não aceita parâmetros malformados, negativos ou absurdamente altos",async()=>{
    expect(await verifyPassword("senha","pbkdf2_sha256$1000000$invalid$invalid")).toBe(false);
    expect(await verifyPassword("senha","pbkdf2_sha256$2000000$invalid$invalid")).toBe(false);
  });
});
