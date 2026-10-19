import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Loader2, Scissors, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { SalesTurnstile } from "./SalesTurnstile";

type Code = "pro" | "scale";
type Payload = {
  contact_name: string;
  company_name: string;
  email: string;
  phone: string;
  plan_code: Code;
  message: string;
  consent: boolean;
  website: string;
};
const start: Payload = {
  contact_name:"",company_name:"",email:"",phone:"",plan_code:"pro",
  message:"",consent:false,website:""
};

export function SalesLeadPage() {
  const [params] = useSearchParams();
  const selected: Code = params.get("plano") === "scale" ? "scale" : "pro";
  const [values,setValues] = useState<Payload>({...start,plan_code:selected});
  const [pending,setPending] = useState(false);
  const [success,setSuccess] = useState<number|null>(null);
  const [error,setError] = useState("");
  const [turnstileToken,setTurnstileToken] = useState("");
  const [challengeEpoch,setChallengeEpoch] = useState(0);
  const health = useQuery({
    queryKey:["sales-lead-health"],
    queryFn:()=>api.get<{ok:boolean;d1:boolean}>("/health"),
    retry:false,staleTime:60_000
  });
  const challenge = useQuery({
    queryKey:["sales-lead-challenge"],
    queryFn:()=>api.get<{enabled:boolean;required:boolean;site_key:string|null}>("/marketing/lead-config"),
    retry:false,staleTime:60_000,
  });
  const canSubmit = health.isSuccess && Boolean(health.data?.d1) &&
    challenge.isSuccess && challenge.data.enabled &&
    (!challenge.data.required || Boolean(turnstileToken));
  const update = <K extends keyof Payload>(key:K,value:Payload[K]) =>
    setValues(p=>({...p,[key]:value}));

  async function submit(e:React.FormEvent) {
    e.preventDefault();setError("");setPending(true);
    try {
      if (!canSubmit) throw new Error("Conclua a verificação de segurança antes de enviar.");
      const result = await api.post<{ok:boolean;reference:number}>("/marketing/leads",{...values,turnstile_token:turnstileToken});
      setSuccess(result.reference);
    } catch(e:unknown) {
      setError(e instanceof Error?e.message:"Não foi possível enviar a solicitação.");
      setTurnstileToken("");
      setChallengeEpoch(n=>n+1);
    } finally {setPending(false);}
  }

  return (
    <div className="texture min-h-screen bg-[#0a0a0c] px-4 py-8 text-zinc-100 sm:py-12">
      <div className="mx-auto max-w-2xl">
        <Link to="/" className="mb-7 inline-flex items-center gap-2 text-xs text-zinc-400 hover:text-[#d4af37]"><ArrowLeft size={15}/> Voltar à página de vendas</Link>
        <div className="rounded-3xl border border-[#35313b] bg-[#16161c] p-5 shadow-xl sm:p-9">
          <div className="mb-5 flex items-center gap-2 font-display text-xl"><Scissors className="text-[#d4af37]"/> tigu</div>
          {success!==null ? (
            <div className="space-y-4 text-center" role="status">
              <CheckCircle2 size={42} className="mx-auto text-emerald-400" />
              <h1 className="font-display text-2xl">Solicitação recebida!</h1>
              <p className="text-sm leading-relaxed text-zinc-300">Registramos seu interesse. O responsável pelo Tigu poderá entrar em contato pelos dados informados.</p>
              <p className="text-xs text-zinc-500">Protocolo #{success}. Nenhuma compra, assinatura ou cobrança foi realizada.</p>
              <Link to="/" className="btn-gold inline-flex rounded-xl px-5 py-3 text-sm font-semibold">Voltar à página inicial</Link>
            </div>
          ) : (
            <>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#d4af37]">Contratação assistida</p>
              <h1 className="mt-2 font-display text-2xl sm:text-3xl">Solicitar informações do plano {values.plan_code==="pro"?"Pro":"Scale"}</h1>
              <p className="mt-2 text-sm leading-relaxed text-zinc-400">Preencha seus dados para receber atendimento comercial. O envio não contrata o plano e não gera pagamento.</p>
              {health.isError || (health.isSuccess && !health.data?.d1) ? (
                <p role="alert" className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
                  Esta prévia está sem backend conectado. O formulário ainda não pode receber solicitações. Não envie dados pessoais nesta demonstração.
                </p>
              ) : null}
              {challenge.isSuccess && !challenge.data.enabled && (
                <p role="alert" className="mt-4 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
                  O formulário está desativado até que a proteção antirobôs Turnstile seja configurada pelo responsável do Tigu.
                </p>
              )}
              <form onSubmit={submit} className="mt-6 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <label className="text-xs text-zinc-300">Seu nome
                    <input required minLength={2} maxLength={90} autoComplete="name" className="input-dark mt-2 w-full" value={values.contact_name} onChange={e=>update("contact_name",e.target.value)}/>
                  </label>
                  <label className="text-xs text-zinc-300">Nome da barbearia
                    <input required minLength={3} maxLength={100} className="input-dark mt-2 w-full" value={values.company_name} onChange={e=>update("company_name",e.target.value)}/>
                  </label>
                  <label className="text-xs text-zinc-300">E-mail
                    <input required type="email" autoComplete="email" maxLength={160} className="input-dark mt-2 w-full" value={values.email} onChange={e=>update("email",e.target.value)}/>
                  </label>
                  <label className="text-xs text-zinc-300">Celular com DDD
                    <input required type="tel" inputMode="tel" autoComplete="tel" minLength={10} maxLength={30} placeholder="55 73 99999-9999" className="input-dark mt-2 w-full" value={values.phone} onChange={e=>update("phone",e.target.value)}/>
                  </label>
                </div>
                <label className="block text-xs text-zinc-300">Plano de interesse
                  <select className="input-dark mt-2 w-full" value={values.plan_code} onChange={e=>update("plan_code",e.target.value as Code)}>
                    <option value="pro">Tigu Pro</option><option value="scale">Tigu Scale</option>
                  </select>
                </label>
                <label className="block text-xs text-zinc-300">Dúvidas ou informações adicionais (opcional)
                  <textarea maxLength={600} rows={4} className="input-dark mt-2 w-full resize-y" value={values.message} onChange={e=>update("message",e.target.value)}/>
                </label>
                <div className="hidden" aria-hidden="true"><label>Site <input type="text" tabIndex={-1} autoComplete="off" value={values.website} onChange={e=>update("website",e.target.value)}/></label></div>
                <label className="flex items-start gap-3 text-xs leading-relaxed text-zinc-400">
                  <input required type="checkbox" className="mt-0.5 accent-[#d4af37]" checked={values.consent} onChange={e=>update("consent",e.target.checked)}/>
                  <span>Autorizo a equipe Tigu a usar meu nome, e-mail e telefone para responder a este pedido comercial. Sei que não estou contratando nem pagando um plano.</span>
                </label>
                {challenge.isSuccess && challenge.data.required && challenge.data.enabled && challenge.data.site_key &&
                  <SalesTurnstile key={challengeEpoch} siteKey={challenge.data.site_key} onToken={setTurnstileToken} />}
                {error && <p role="alert" className="rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-300">{error}</p>}
                <button type="submit" disabled={pending || !canSubmit}
                  className="btn-gold inline-flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50">
                  {pending?<Loader2 size={16} className="animate-spin"/>:<ShieldCheck size={16}/>}
                  {pending?"Enviando…":"Enviar solicitação de atendimento"}
                </button>
                <p className="text-center text-[11px] text-zinc-500">Seus dados serão utilizados somente para o atendimento comercial solicitado. Nenhum pagamento será iniciado.</p>
              </form>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
