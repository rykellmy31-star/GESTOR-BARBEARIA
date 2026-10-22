/** Conteúdo somente em memória, montado após cadastro aprovado.
 * Nunca envie esta mensagem para analytics, logs, banco, ou servidor. */
export interface OwnerWelcomeDetails {
  companyName: string;
  ownerName: string;
  ownerEmail: string;
  slug: string;
  planCode: string;
  trialEnd: string;
  trialDays: number;
  initialPassword?: string;
  createdUser: boolean;
  origin: string;
}
export function formatTrialEnd(iso: string): string {
  const time = new Date(iso);
  if (!Number.isFinite(time.getTime())) return "data não informada";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short", timeStyle: "short", timeZone: "America/Bahia",
  }).format(time);
}

/** Plano selecionado NÃO significa cobrança/assinatura paga.
 * O acesso inicial é um teste grátis com data de término conferida pelo D1. */
export function buildOwnerWelcomeMessage(d: OwnerWelcomeDetails): string {
  const origin = d.origin.replace(/\/$/, "");
  const password = d.createdUser
    ? (d.initialPassword ? `Senha provisória: ${d.initialPassword}\nTroque sua senha no primeiro acesso.`
      : "Senha provisória indisponível. Solicite nova senha ao administrador TIGU.")
    : "Senha: utilize a senha da sua conta TIGU já existente (nenhuma senha foi redefinida).";
  return [
    "✂️ BEM-VINDO(A) À TIGU!",
    "",
    `Proprietário(a): ${d.ownerName.trim()}`,
    `Barbearia: ${d.companyName.trim()}`,
    `E-mail de login: ${d.ownerEmail.trim().toLowerCase()}`,
    password,
    "",
    `Plano selecionado: ${d.planCode.toUpperCase()}`,
    `Situação: teste gratuito por ${d.trialDays} dias — sem cobrança iniciada.`,
    `Validade do acesso de teste: até ${formatTrialEnd(d.trialEnd)} (horário da Bahia).`,
    "Após o teste, a continuidade depende da contratação e confirmação do pagamento do plano.",
    "",
    `Entrar no sistema: ${origin}/login`,
    `Página da barbearia: ${origin}/c/${d.slug}`,
    "",
    "Guarde estes dados em segurança. Não compartilhe sua senha com outras pessoas.",
    "Equipe TIGU",
  ].join("\n");
}


/** Segunda via do convite após o cadastro: nunca recupera a senha antiga.
 * A senha provisória só é incluída após o Super Admin confirmar uma redefinição.
 * Datas e status vêm do D1, sem presumir que o plano esteja pago. */
export interface OwnerAccessDetails {
  companyName: string;
  ownerName: string;
  ownerEmail: string;
  slug: string;
  planCode: string;
  subscriptionStatus: string | null;
  periodEnd: string | null;
  origin: string;
  temporaryPassword?: string;
}
export function buildOwnerAccessMessage(d: OwnerAccessDetails): string {
  const root=d.origin.replace(/\/$/, "");
  const status:Record<string,string>={
    trial:"Teste gratuito (sem cobrança confirmada)",
    active:"Ativo (consulte as condições financeiras do contrato)",
    past_due:"Pagamento ou renovação pendente",
    cancelled:"Cancelado",
  };
  const situation=status[d.subscriptionStatus??""]??"Não informado";
  const expiry=d.periodEnd
    ? `Validade do período atual: ${formatTrialEnd(d.periodEnd)} (horário de Brasília/Bahia).`
    : "Validade: não informada. Consulte o administrador da plataforma.";
  const credentials=d.temporaryPassword
    ? [`Nova senha provisória: ${d.temporaryPassword}`,
       "ATENÇÃO: a senha anterior foi substituída e as sessões anteriores foram encerradas.",
       "Você deverá trocar essa senha no primeiro acesso."]
    : ["Senha: utilize a senha atual da sua conta TIGU.",
       "A senha antiga não pode ser recuperada ou consultada. Para substituí-la, solicite uma nova senha provisória."];
  return [
    "✂️ TIGU — DADOS DE ACESSO DA BARBEARIA",
    "",
    `Proprietário(a): ${d.ownerName.trim()}`,
    `Barbearia: ${d.companyName.trim()}`,
    `Usuário para login (e-mail): ${d.ownerEmail.trim().toLowerCase()}`,
    ...credentials,
    "",
    `Plano: ${d.planCode.toUpperCase()}`,
    `Situação do plano: ${situation}`,
    expiry,
    "",
    `LINK PARA ENTRAR NO PAINEL: ${root}/login`,
    `LINK PARA DIVULGAR A BARBEARIA E RECEBER AGENDAMENTOS: ${root}/c/${encodeURIComponent(d.slug)}`,
    "",
    "Compartilhe o link de divulgação com os clientes.",
    "Envie os dados de acesso somente ao proprietário, em canal privado.",
    "Equipe TIGU",
  ].join("\n");
}
