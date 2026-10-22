import { describe, expect, it } from "vitest";
import { buildOwnerWelcomeMessage, buildOwnerAccessMessage, formatTrialEnd } from "./owner-welcome";

const base={
  companyName:"Barbearia Sol Nascente",
  ownerName:"João Silva",
  ownerEmail:" JOAO@EXAMPLE.TEST ",
  slug:"sol-nascente",
  planCode:"pro",
  trialEnd:"2026-11-06T10:00:00Z",
  trialDays:15,
  origin:"https://agendamentos.crjornada.com/",
  initialPassword:"SenhaTemporaria!123",
  createdUser:true,
};
describe("mensagem de boas-vindas ao proprietário (somente no momento do cadastro)",()=>{
  it("inclui login, senha inicial, plano e vencimento do teste com URL correta",()=>{
    const text=buildOwnerWelcomeMessage(base);
    expect(text).toContain("Barbearia: Barbearia Sol Nascente");
    expect(text).toContain("Proprietário(a): João Silva");
    expect(text).toContain("E-mail de login: joao@example.test");
    expect(text).toContain("Senha provisória: SenhaTemporaria!123");
    expect(text).toContain("Plano selecionado: PRO");
    expect(text).toContain("15 dias");
    expect(text).toContain("06/11/2026");
    expect(text).toContain("https://agendamentos.crjornada.com/login");
    expect(text).toContain("https://agendamentos.crjornada.com/c/sol-nascente");
    expect(text).toContain("sem cobrança iniciada");
  });
  it("não revela senha informada se conta do proprietário já existia",()=>{
    const message=buildOwnerWelcomeMessage({...base,createdUser:false});
    expect(message).not.toContain("SenhaTemporaria!123");
    expect(message).toContain("conta TIGU já existente");
  });
  it("suporta senhas automáticas indisponíveis sem inventar credenciais",()=>{
    const message=buildOwnerWelcomeMessage({...base,initialPassword:undefined});
    expect(message).toContain("Solicite nova senha");
    expect(message).not.toContain("undefined");
  });
  it("apresenta data brasileira mesmo em ambiente de locale inglês",()=>{
    expect(formatTrialEnd("2026-11-06T10:00:00Z")).toContain("06/11/2026");
  });
});

describe("cópia posterior de acesso e divulgação",()=>{
  const details={
    companyName:"Gênesis Evolução",
    ownerName:"Marcos",
    ownerEmail:" MARCOS@EXAMPLE.TEST ",
    slug:"genesis-evolucao",
    planCode:"free",
    subscriptionStatus:"trial",
    periodEnd:"2026-11-06T10:00:00Z",
    origin:"https://agendamentos.crjornada.com/",
  };
  it("exibe nome, login, plano, validade e URL de divulgação sem senha antiga",()=>{
    const msg=buildOwnerAccessMessage(details);
    expect(msg).toContain("Gênesis Evolução");
    expect(msg).toContain("Marcos");
    expect(msg).toContain("marcos@example.test");
    expect(msg).toContain("Plano: FREE");
    expect(msg).toContain("Teste gratuito");
    expect(msg).toContain("06/11/2026");
    expect(msg).toContain("https://agendamentos.crjornada.com/login");
    expect(msg).toContain("https://agendamentos.crjornada.com/c/genesis-evolucao");
    expect(msg).not.toContain("Senha provisória:");
    expect(msg).toContain("senha antiga não pode ser recuperada");
  });
  it("depois da redefinição mostra somente a nova senha e o aviso de revogação",()=>{
    const msg=buildOwnerAccessMessage({...details,temporaryPassword:"Tigu!SenhaProvisoria123"});
    expect(msg).toContain("Nova senha provisória: Tigu!SenhaProvisoria123");
    expect(msg).toContain("senha anterior foi substituída");
    expect(msg).toContain("trocar essa senha");
  });
  it("assinatura ativa não é rotulada falsamente como teste gratuito",()=>{
    const msg=buildOwnerAccessMessage({...details,subscriptionStatus:"active"});
    expect(msg).toContain("Situação do plano: Ativo");
    expect(msg).not.toContain("Situação do plano: Teste gratuito");
  });
});
