import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Spinner } from "@/components/ui";
import { H } from "./shared";

type Status = {
  staging: boolean;
  readiness: {
    d1_set: boolean;
    r2_set: boolean;
    session_secret_ready: boolean;
    encryption_key_ready: boolean;
    turnstile_site_key_set: boolean;
    turnstile_secret_set: boolean;
    leads_form_ready: boolean;
    sales_contact_enabled: boolean;
    sales_contact_channel_ready: boolean;
    production_site_ready: boolean;
  };
  payment: { access_token_set: boolean; webhook_secret_set: boolean; public_url_set: boolean; enabled_in_environment: boolean };
  whatsapp: { provider:"evolution"; url_set:boolean; api_key_set:boolean; webhook_secret_set:boolean; callback_public_url_set:boolean; provider_disabled_in_staging:boolean };
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
    <H title="Integrações da plataforma" sub="Mercado Pago e Evolution API para WhatsApp. Nenhuma credencial secreta é exibida neste painel." />
    {q.isLoading ? <Spinner /> : q.isError || !q.data ?
      <p role="alert" className="text-amber-300">Não foi possível consultar as configurações. Confira a publicação do Worker.</p> :
      <>
        {q.data.staging && <p className="rounded-xl border border-amber-600/40 bg-amber-900/10 p-4 text-sm text-amber-200">
          Homologação: pagamentos e mensagens reais permanecem bloqueados intencionalmente, mesmo com as credenciais configuradas.
        </p>}
        <section className="rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
          <h2 className="text-lg font-semibold text-white">Prontidão para comercialização</h2>
          <p className="mt-2 text-sm text-zinc-400">
            Diagnóstico de presença de configurações, sem exibir chaves. Não substitui testes
            de cobrança, envio real ou recuperação de backups.
          </p>
          <FieldStatus label="D1 — banco conectado" configured={q.data.readiness.d1_set} />
          <FieldStatus label="R2 — arquivos conectados" configured={q.data.readiness.r2_set} />
          <FieldStatus label="Segredo de sessão forte" configured={q.data.readiness.session_secret_ready} />
          <FieldStatus label="Chave de criptografia WhatsApp" configured={q.data.readiness.encryption_key_ready} />
          <FieldStatus label="SALES_TURNSTILE_SITE_KEY" configured={q.data.readiness.turnstile_site_key_set} />
          <FieldStatus label="SALES_TURNSTILE_SECRET" configured={q.data.readiness.turnstile_secret_set} />
          <FieldStatus label="Formulário de interessados protegido" configured={q.data.readiness.leads_form_ready} />
          <FieldStatus label="Contato comercial ativado" configured={q.data.readiness.sales_contact_enabled} />
          <FieldStatus label="Canal de contato configurado" configured={q.data.readiness.sales_contact_channel_ready} />
          <FieldStatus label="Ambiente de produção (não homologação)" configured={q.data.readiness.production_site_ready} />
          <p className="mt-3 text-sm text-zinc-400">
            Configure o Turnstile no Cloudflare, salve as duas chaves como variável/segredo
            do Worker apropriado e ative o contato em Super Admin → Config. plataforma.
            No staging, o formulário protegido permanece bloqueado até existir proteção válida.
          </p>
          <a className="mt-3 inline-block text-sm text-[var(--c-gold)] underline"
            href="https://dash.cloudflare.com/" target="_blank" rel="noreferrer">
            Abrir Cloudflare para configurar
          </a>
        </section>
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
          <h2 className="text-lg font-semibold text-white">WhatsApp — Evolution API</h2>
          <p className="mt-2 text-sm text-zinc-400">Servidor externo Evolution v2, conexão QR Code individual por barbearia e webhook autenticado.</p>
          <FieldStatus label="EVOLUTION_API_URL (HTTPS)" configured={q.data.whatsapp.url_set} />
          <FieldStatus label="EVOLUTION_API_KEY (Secret)" configured={q.data.whatsapp.api_key_set} />
          <FieldStatus label="EVOLUTION_WEBHOOK_SECRET (Secret)" configured={q.data.whatsapp.webhook_secret_set} />
          <FieldStatus label="PUBLIC_URL (callback HTTPS)" configured={q.data.whatsapp.callback_public_url_set} />
          <p className="mt-3 text-sm text-zinc-400">Sem servidor e segredos configurados não há conexão real por QR Code. As credenciais devem ficar exclusivamente em Secrets do Worker; não cole tokens no navegador nem no GitHub.</p>
          <p className="mt-2 text-xs text-amber-300">Aviso: Evolution via WhatsApp Web/Baileys não é API oficial e pode sofrer desconexões ou bloqueios.</p>
        </section>
        <p className="text-xs text-zinc-500">Esta tela verifica presença das credenciais, não valida cobranças ou envios reais. Após salvar os segredos na Cloudflare, atualize o painel. Nenhuma cobrança ou mensagem é disparada aqui.</p>
      </>
    }
  </div>;
}
