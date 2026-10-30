import { Link, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Scissors, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";

type Code = "pro" | "scale";
type Plan = {code:string;name:string;price_cents_month:number};
const brl=(c:number)=>(c/100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});

/** Contratação comercial assistida: não coleta pagamento nem cria empresa automaticamente. */
export function PurchasePlanPage(){
  const [params]=useSearchParams();
  const selected:Code=params.get("plano")==="scale"?"scale":"pro";
  const plans=useQuery({queryKey:["purchase-plan-prices"],
    queryFn:()=>api.get<{plans:Plan[]}>("/marketing/plans"),retry:false,staleTime:30_000});
  const plan=plans.data?.plans?.find(p=>p.code===selected);
  return <div className="texture min-h-screen bg-[#0a0a0c] px-4 py-9 text-zinc-100">
    <div className="mx-auto max-w-2xl">
      <Link to="/#planos" className="mb-6 inline-flex items-center gap-2 text-sm text-zinc-400"><ArrowLeft size={16}/> Voltar aos planos</Link>
      <div className="rounded-3xl border border-[#35313b] bg-[#16161c] p-5 sm:p-9">
        <p className="flex items-center gap-2 text-sm text-[var(--c-gold)]"><Scissors size={18}/> TIGU · Contratação assistida</p>
        <h1 className="mt-4 font-display text-3xl">Escolher {selected==="pro"?"TIGU Pro":"TIGU Scale"}</h1>
        <p className="mt-2 text-sm text-zinc-400">
          {plan?brl(plan.price_cents_month)+"/mês":"Consulte o preço oficial com o responsável."}
        </p>
        <div className="mt-6 rounded-xl border border-[var(--c-gold)]/30 bg-[var(--c-gold)]/5 p-5">
          <p className="flex gap-2 text-sm text-zinc-200"><ShieldCheck size={18} className="shrink-0 text-[var(--c-gold)]"/>
            A mensalidade é combinada e cobrada diretamente pelo responsável pela CR Jornada, fora do TIGU.</p>
          <p className="mt-3 text-sm text-zinc-400">A seleção do plano não gera Pix nem cobrança. O cadastro e a liberação são realizados pelo Super Admin após a contratação.</p>
          <p className="mt-3 text-xs text-zinc-500">Os pagamentos opcionais pelos serviços dos barbeiros são independentes da assinatura da plataforma.</p>
        </div>
        <Link to={`/contratar?plano=${selected}`} className="btn-gold mt-6 flex w-full justify-center rounded-xl px-5 py-3 text-sm font-semibold">
          Solicitar contratação do plano
        </Link>
        {plans.isError&&<p role="alert" className="mt-3 text-xs text-amber-200">Preço indisponível. Confirme as condições com o responsável.</p>}
      </div>
    </div>
  </div>;
}
