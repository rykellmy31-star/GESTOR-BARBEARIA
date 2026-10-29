import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui";

type Code = "free" | "pro" | "scale";
type Plan = {code:Code;name:string;price_cents_month:number;max_barbers:number;max_messages_month:number;whatsapp_enabled:number;store_enabled:number};
export type ManualBillingSummary = {
  subscription: {plan_code:string;status:string;period_end:string|null;name:string;price_cents_month:number}|null;
  plans: Plan[];
  plan_request: {id:number;plan_code:string;created_at:string}|null;
};
const brl=(c:number)=>(c/100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});

export function ManualSubscriptionView({data}:{data:ManualBillingSummary}) {
  const [selected,setSelected]=useState<Code>((data.subscription?.plan_code as Code)??"pro");
  const toast=useToast(),qc=useQueryClient();
  const request=useMutation({
    mutationFn:(plan_code:Code)=>api.post<{request_id:number}>("/billing/plan-request",{plan_code}),
    onSuccess:r=>{
      toast.push("ok",`Solicitação #${r.request_id} registrada. O responsável informará o pagamento e liberará o plano.`);
      void qc.invalidateQueries({queryKey:["subscription-billing"]});
    },
    onError:(e:Error)=>toast.push("err",e.message)
  });
  const sub=data.subscription;
  const end=sub?.period_end?new Date(sub.period_end):null;
  const valid=Boolean(end&&end.getTime()>Date.now()&&(sub?.status==="active"||sub?.status==="trial"));
  return <div className="mx-auto max-w-3xl space-y-5">
    <Link to="../dashboard" className="text-xs text-zinc-400">← Voltar ao painel</Link>
    <div className="rounded-2xl border border-[var(--c-gold)]/40 bg-[#16161c] p-5 sm:p-8">
      <p className="text-xs font-semibold uppercase tracking-wider text-[var(--c-gold)]">Mensalidade do TIGU · pagamento externo</p>
      <h1 className="mt-3 font-display text-2xl text-white">Sua assinatura</h1>
      <p className="mt-3 text-sm text-zinc-300">Plano atual: <strong>{sub?.name??sub?.plan_code??"Não encontrado"}</strong></p>
      <p className="mt-2 text-sm text-zinc-300">{valid?"Acesso liberado":"Assinatura vencida ou inativa"}{end?` · até ${end.toLocaleDateString("pt-BR")}`:""}.</p>
      <p className="mt-3 text-xs text-zinc-400">A CR Jornada recebe mensalidades diretamente, fora do TIGU. Selecionar ou solicitar um plano não gera cobrança, não altera seu acesso e não confirma pagamento.</p>
    </div>
    <section className="rounded-2xl border border-[#303039] bg-[#16161c] p-5 sm:p-8">
      <h2 className="font-display text-xl text-white">Escolher plano</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-3" role="group" aria-label="Selecione seu plano">
        {data.plans.map(plan=><button type="button" key={plan.code} aria-pressed={selected===plan.code}
          onClick={()=>setSelected(plan.code)} className={`rounded-xl border p-4 text-left ${selected===plan.code?"border-[var(--c-gold)] bg-[var(--c-gold)]/10":"border-[#35313b]"}`}>
          <span className="block font-semibold">{plan.name}</span>
          <span className="mt-2 block text-lg text-[var(--c-gold)]">{brl(plan.price_cents_month)}/mês</span>
          <span className="mt-2 block text-xs text-zinc-400">{plan.max_barbers===-1?"Profissionais ilimitados":`${plan.max_barbers} profissionais`}</span>
        </button>)}
      </div>
      {data.plan_request?<p role="status" className="mt-4 rounded-xl border border-amber-500/40 p-3 text-sm text-amber-200">
        Solicitação #{data.plan_request.id} do plano {data.plan_request.plan_code.toUpperCase()} pendente de análise. Entre em contato com o responsável para concluir o pagamento por fora.
      </p>:null}
      <button type="button" onClick={()=>request.mutate(selected)} disabled={request.isPending||Boolean(data.plan_request)||!data.plans.some(p=>p.code===selected)}
        className="btn-gold mt-5 inline-flex w-full justify-center rounded-xl px-5 py-3 font-semibold disabled:opacity-50">
        {request.isPending?"Enviando…":"Solicitar plano selecionado"}
      </button>
      <p className="mt-3 text-xs text-zinc-500">O plano somente será alterado após confirmação manual pelo Super Admin. Pagamentos opcionais dos profissionais são independentes desta mensalidade.</p>
    </section>
  </div>;
}
