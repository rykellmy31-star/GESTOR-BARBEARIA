import { afterEach, describe, expect, it, vi } from "vitest";
import { evolutionInstanceName, evolutionQR, evolutionReady, evolutionState, renderEvolutionText, evolutionRequest, evolutionProvider } from "../api/lib/messaging/evolution";
import { evolutionWebhookRouter } from "../api/routes/evolution-webhook";

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
    expect(evolutionReady({...config, EVOLUTION_API_URL:"https://evolution.example.com/api"})).toBe(false);
    expect(evolutionReady({...config, PUBLIC_URL:"https://agendamentos.example.com/?token=x"})).toBe(false);
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

describe("Evolution API - comunicação segura com provedor v2", () => {
  afterEach(() => vi.restoreAllMocks());

  it("sem servidor configurado não chama a internet", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await evolutionRequest({}, "POST", "/message/sendText/tigu-company-1", { number: "5575999990000", text: "Oi" });
    expect(result.status).toBe(503);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("usa apenas origem global e apikey no Worker, nunca token de proprietário", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({key:{id:"message-id-123"}}), {status:201,headers:{"content-type":"application/json"}})
    );
    const db = { prepare: () => ({ bind: () => ({ first: async () => ({body_text:"Olá {{1}}! Seu horário: {{4}}"}) }) }) };
    const result = await evolutionProvider.sendTemplate({
      env: config, db, conn: { company_id:77,phone_number_id:"tigu-company-77" },
      demo: false,
    } as never, {
      to:"5575999990000",templateCode:"tigu_lembrete",language:"pt_BR",
      variables:[{key:"1",sample:"Cliente"},{key:"4",sample:"14:00"}],
    });
    expect(result).toMatchObject({accepted:true, permanent:false, providerCostCents:0});
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://evolution.example.com/message/sendText/tigu-company-77");
    expect((init as RequestInit).headers).toMatchObject({apikey:config.EVOLUTION_API_KEY});
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({number:"5575999990000",text:"Olá Cliente! Seu horário: 14:00"});
  });

  it("não afirma envio sem ID de mensagem retornado pela Evolution", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ok:true}),{status:200}));
    const db = {prepare: () => ({bind: () => ({first:async()=>({body_text:"Lembrete {{1}}"})})})};
    const result = await evolutionProvider.sendTemplate({
      env:config,db,conn:{company_id:77,phone_number_id:"tigu-company-77"},demo:false
    } as never,{to:"5575999990000",templateCode:"tigu_lembrete",language:"pt_BR",variables:[{key:"1",sample:"Ana"}]});
    expect(result.accepted).toBe(false);
    expect(result.uncertain).toBe(true);
    expect(result.providerCostCents).toBeUndefined();
  });
});

describe("Evolution API - webhook sem acesso entre barbearias", () => {
  const payload = JSON.stringify({event:"messages.upsert",instance:"tigu-company-17",data:{key:{id:"x",fromMe:false}}});
  const req = (token:string) => evolutionWebhookRouter.request("https://tigu.example.com/", {
    method:"POST",headers:{"Content-Type":"application/json","x-tigu-webhook-token":token},
    body:payload,
  }, {EVOLUTION_WEBHOOK_SECRET:config.EVOLUTION_WEBHOOK_SECRET,TIGU_STAGING:"0"} as never);

  it("nega chamadas sem segredo antes de acessar o banco", async () => {
    expect((await req("")).status).toBe(401);
    expect((await req("wrong-secret")).status).toBe(401);
  });

  it("nega eventos reais em staging mesmo com o segredo correto", async () => {
    const response = await evolutionWebhookRouter.request("https://tigu.example.com/",{
      method:"POST",headers:{"Content-Type":"application/json","x-tigu-webhook-token":config.EVOLUTION_WEBHOOK_SECRET},
      body:payload,
    },{EVOLUTION_WEBHOOK_SECRET:config.EVOLUTION_WEBHOOK_SECRET,TIGU_STAGING:"1"} as never);
    expect(response.status).toBe(403);
  });
});
