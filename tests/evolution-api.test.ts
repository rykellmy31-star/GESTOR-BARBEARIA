import { describe, expect, it } from "vitest";
import { evolutionInstanceName, evolutionQR, evolutionReady, evolutionState, renderEvolutionText } from "../api/lib/messaging/evolution";

const config = {
  EVOLUTION_API_URL: "https://evolution.example.com",
  EVOLUTION_API_KEY: "test-key-not-real",
  EVOLUTION_WEBHOOK_SECRET: "long-webhook-secret-for-testing-123456",
  PUBLIC_URL: "https://agendamentos.example.com",
};

describe("Evolution API - preparação sem instalação", () => {
  it("não libera o conector sem todas as configurações seguras", () => {
    expect(evolutionReady({})).toBe(false);
    expect(evolutionReady({...config, EVOLUTION_API_URL: "http://evolution.example.com"})).toBe(false);
    expect(evolutionReady({...config, PUBLIC_URL: ""})).toBe(false);
    expect(evolutionReady({...config, EVOLUTION_WEBHOOK_SECRET: ""})).toBe(false);
    expect(evolutionReady(config)).toBe(true);
  });

  it("usa um identificador estável por empresa e recusa identificador inválido", () => {
    expect(evolutionInstanceName(12)).toBe("tigu-company-12");
    expect(evolutionInstanceName(13)).not.toBe(evolutionInstanceName(12));
    expect(() => evolutionInstanceName(0)).toThrow();
    expect(() => evolutionInstanceName(1.2)).toThrow();
  });

  it("não aceita imagens arbitrárias devolvidas pelo servidor", () => {
    expect(evolutionQR({base64:"data:image/svg+xml;base64,PHN2Zz4="})).toBeNull();
    expect(evolutionQR({base64:"https://example.com/image"})).toBeNull();
    expect(evolutionQR({qrcode:{base64:"data:image/png;base64,aGVsbG8="}}))
      .toBe("data:image/png;base64,aGVsbG8=");
  });

  it("renderiza os seis campos usados pelo motor antigo de notificações", () => {
    expect(renderEvolutionText("Olá {{1}}, seu serviço {{2}} será com {{3}}.", [
      {key:"1",sample:"Ana"}, {key:"2",sample:"Corte"}, {key:"3",sample:"João"},
    ])).toBe("Olá Ana, seu serviço Corte será com João.");
    expect(renderEvolutionText("Sem {{9}}",[])).toBe("Sem ");
  });

  it("não confunde sessão conectada com sessão aguardando QR", () => {
    expect(evolutionState({instance:{state:"open"}})).toBe("connected");
    expect(evolutionState({instance:{state:"connecting"}})).toBe("pending_setup");
  });
});
