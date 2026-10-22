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
