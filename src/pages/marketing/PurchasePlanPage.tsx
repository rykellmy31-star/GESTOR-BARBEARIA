import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, CreditCard, LockKeyhole, Scissors, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";

type Code = "pro" | "scale";
type Plan = {code:string;name:string;price_cents_month:number};
const money=(cents:number)=>(cents/100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});

/**
 * Entrada do checkout direto. NUNCA cria uma barbearia ou coleta uma senha
 * antes de um pagamento efetivamente homologado.
 * Não redirecionar para MP nem inventar um Pix enquanto o fluxo protegido
 * de pré-cadastro, idempotência e webhook de ativação não estiver completo.
 */
export function PurchasePlanPage(){
  const [params]=useSearchParams();
  const selected:Code=params.get("plano")==="scale"?"scale":"pro";
  const [email,setEmail]=useState("");
  const [accepted,setAccepted]=useState(false);
  const plans=useQuery({
    queryKey:["purchase-plan-prices"],
    queryFn:()=>api.get<{plans:Plan[];automatic_billing:boolean}>("/marketing/plans"),
    retry:false,staleTime:30_000
  });
  const health=useQuery({
    queryKey:["purchase-live-gateway-health"],
    queryFn:()=>api.get<{staging:boolean;payments:{mercadopago:boolean}} >("/health"),
    retry:false,staleTime:30_000
  });
  const plan=plans.data?.plans?.find(p=>p.code===selected);
  const safeDisplay=Boolean(plan&&Number.isInteger(plan.price_cents_month)&&plan.price_cents_month>0);
  // Um token presente não prova que o webhook está configurado ou que
  // a compra poderá provisionar uma nova barbearia após a confirmação.
  const ready=false;
  const contactHref=`/contratar?plano=${selected}`;
  return <div className="texture min-h-screen bg-[#0a0a0c] px-4 py-9 text-zinc-100">
    <div className="mx-auto max-w-2xl">
      <Link to="/#planos" className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400">
        <ArrowLeft size={16}/> Voltar aos planos
      </Link>
      <div className="rounded-3xl border border-[#35313b] bg-[#16161c] p-5 sm:p-9">
        <p className="flex items-center gap-2 text-sm text-[var(--c-gold)]">
          <Scissors size={18}/> TIGU · Contratação direta
        </p>
        <h1 className="mt-4 font-display text-3xl">Adquirir {selected==="pro"?"Tigu Pro":"Tigu Scale"}</h1>
        <p className="mt-2 text-sm text-zinc-400">
          {safeDisplay?money(plan!.price_cents_month)+"/mês":"Consultando preço oficial do plano…"}
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {["1. Confirmar plano e pagamento","2. Verificar aprovação do Pix","3. Criar login e barbearia"].map(step=>
            <div key={step} className="rounded-xl border border-[#33343a] p-3 text-xs text-zinc-300">
              <ShieldCheck size={17} className="mb-2 text-[var(--c-gold)]"/>{step}
            </div>
          )}
        </div>
        <div className="mt-6 space-y-4">
          <label className="block text-sm">E-mail do futuro proprietário
            <input type="email" autoComplete="email" maxLength={160} value={email}
              onChange={e=>setEmail(e.target.value)}
              placeholder="voce@exemplo.com"
              className="input-dark mt-2 w-full"/>
          </label>
          <label className="flex items-start gap-2 text-xs text-zinc-300">
            <input type="checkbox" className="mt-0.5" checked={accepted}
              onChange={e=>setAccepted(e.target.checked)}/>
            Entendi que a barbearia será criada somente depois da confirmação do pagamento.
          </label>
          {!ready&&<div role="status" className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-4 text-sm text-amber-100">
            <p className="flex items-center gap-2 font-semibold"><LockKeyhole size={16}/>
              Checkout direto em homologação
            </p>
            <p className="mt-2 leading-relaxed">
              Para sua segurança, o Pix direto ainda não está liberado neste ambiente.
              A integração de pagamento e a criação automática da barbearia precisam
              passar pelos testes de aprovação, webhook e prevenção de cobranças duplicadas.
              Nenhuma cobrança nem cadastro é feito nesta página.
            </p>
          </div>}
          <button type="button" disabled className="btn-gold flex w-full cursor-not-allowed items-center justify-center gap-2 rounded-xl px-5 py-3 opacity-50">
            <CreditCard size={18}/> Pagar e continuar — aguardando homologação
          </button>
          <Link to={contactHref} className="flex w-full justify-center rounded-xl border border-[#45454b] px-5 py-3 text-sm font-semibold text-zinc-200">
            Solicitar atendimento comercial
          </Link>
          {health.data?.staging&&
            <p className="text-xs text-zinc-500">Ambiente de homologação: cobranças reais bloqueadas.</p>}
          {plans.isError&&<p role="alert" className="text-xs text-amber-200">
            Não foi possível consultar o preço oficial. Nenhuma cobrança está disponível.
          </p>}
        </div>
      </div>
    </div>
  </div>;
}
