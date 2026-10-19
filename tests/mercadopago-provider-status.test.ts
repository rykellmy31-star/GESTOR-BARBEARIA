import { afterEach, describe, expect, it, vi } from "vitest";
import { mpProvider } from "../api/lib/payments";
import type { Env } from "../api/types";

const originalFetch = globalThis.fetch;
afterEach(() => {
  vi.stubGlobal("fetch", originalFetch);
  vi.restoreAllMocks();
});

describe("Mercado Pago: consulta confiável do pagamento", () => {
  const env = { MP_ACCESS_TOKEN: "token-de-teste", TIGU_STAGING: "0" } as Env;

  it("não interpreta HTTP 500 como pagamento inexistente", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({status:"approved"}), {status:500})));
    expect((await mpProvider(env).getPaymentStatus("123")).status).toBe("error");
  });

  it("não aceita resposta 200 sem campo status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({id:123}), {status:200})));
    expect((await mpProvider(env).getPaymentStatus("123")).status).toBe("error");
  });

  it("retorna status aprovado somente após resposta HTTP válida", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({id:123,status:"approved"}), {status:200}));
    vi.stubGlobal("fetch", fetchMock);
    const result = await mpProvider(env).getPaymentStatus("123");
    expect(result.status).toBe("approved");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("mantém bloqueio absoluto no staging", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect((await mpProvider({...env,TIGU_STAGING:"1"}).getPaymentStatus("123")).status).toBe("error");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
