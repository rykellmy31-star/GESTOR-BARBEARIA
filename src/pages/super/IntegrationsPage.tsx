import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Spinner } from "@/components/ui";
import { H } from "./shared";

type Status = {
  staging: boolean;
  payment: { access_token_set: boolean; webhook_secret_set: boolean; public_url_set: boolean; enabled_in_environment: boolean };
  whatsapp: { app_id_set: boolean; app_secret_set: boolean; webhook_verify_token_set: boolean; encryption_key_set: boolean; embedded_signup_set: boolean; provider_disabled_in_staging: boolean };
};

function FieldStatus({ label, configured }: { label: string; configured: boolean }) {
  return <div className="flex items-center justify-between gap-3 border-b border-[#26262f] py-2 text-sm">
    <span className="text-zinc-200">{label}</span>
    <span className={configured ? "text-emerald-300" : "text-amber-300"}>{configured ? "Configurado" : "Pendente"}</span>
  </div>;
}

export function SuperIntegrations() {
  const q = useQuery({ queryKey: ["super-integrations"], queryFn: () => api.get<Status>("/super/integrations/status") });
  return <div className="space-y-5">
    <H title="Integrações da plataforma" sub="Mercado Pago (recargas e planos) e Meta WhatsApp Cloud API. Os valores secretos nunca são mostrados neste painel." />
    {q.isLoading ? <Spinner /> : q.isError || !q.data ?
      <p role="alert" className="text-amber-300">Não foi possível consultar as configurações. Confira a publicação do Worker.</p> :
      <>
        {q.data.staging && <p className="rounded-xl border border-amber-600/40 bg-amber-900/10 p-4 text-sm text-amber-200">
          Homologação: pagamentos e mensagens reais permanecem bloqueados intencionalmente, mesmo com as credenciais configuradas.
        </p>}
        <section className="rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
          <h2 className="text-lg font-semibold text-white">Mercado Pago — planos e recargas Pix</h2>
          <p className="mt-2 text-sm text-zinc-400">Credenciais da conta da plataforma TIGU, não a conta individual de cada barbearia.</p>
          <FieldStatus label="MP_ACCESS_TOKEN" configured={q.data.payment.access_token_set} />
          <FieldStatus label="MP_WEBHOOK_SECRET" configured={q.data.payment.webhook_secret_set} />
          <FieldStatus label="PUBLIC_URL (endereço HTTPS)" configured={q.data.payment.public_url_set} />
          <p className="mt-3 text-sm text-zinc-400">Configure esses nomes em Cloudflare → Workers & Pages → Worker TIGU → Settings → Variables and Secrets. Use Secrets para o token e para o segredo do webhook. O sistema exige confirmação do provedor antes de creditar pagamentos.</p>
          <a className="mt-3 inline-block text-sm text-[var(--c-gold)] underline" href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">Abrir Cloudflare para configurar credenciais</a>
        </section>
        <section className="rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
          <h2 className="text-lg font-semibold text-white">WhatsApp — Meta Cloud API</h2>
          <p className="mt-2 text-sm text-zinc-400">Configuração da aplicação e do webhook global. A conexão do número de cada barbearia continua sendo feita separadamente.</p>
          <FieldStatus label="WHATSAPP_APP_ID" configured={q.data.whatsapp.app_id_set} />
          <FieldStatus label="WHATSAPP_APP_SECRET" configured={q.data.whatsapp.app_secret_set} />
          <FieldStatus label="WHATSAPP_WEBHOOK_VERIFY_TOKEN" configured={q.data.whatsapp.webhook_verify_token_set} />
          <FieldStatus label="MSG_ENC_KEY (criptografia de tokens)" configured={q.data.whatsapp.encryption_key_set} />
          <FieldStatus label="WHATSAPP_EMBEDDED_CONFIG_ID (conexão assistida)" configured={q.data.whatsapp.embedded_signup_set} />
          <p className="mt-3 text-sm text-zinc-400">Salve os segredos no Worker usando Cloudflare → Settings → Variables and Secrets; não cole tokens em mensagens, commits ou campos comuns de texto.</p>
          <a className="mt-3 inline-block text-sm text-[var(--c-gold)] underline" href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Abrir Meta for Developers</a>
        </section>
        <p className="text-xs text-zinc-500">Esta tela verifica presença das credenciais, não valida cobranças ou envios reais. Após salvar os segredos na Cloudflare, atualize o painel. Nenhuma cobrança ou mensagem é disparada aqui.</p>
      </>
    }
  </div>;
}
