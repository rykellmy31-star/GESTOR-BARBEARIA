import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui";

type PlanCode = "free" | "pro" | "scale";
type Request = {id:number;plan_code:PlanCode;status:string;created_at:string};
type Renewal = {id:number;plan_code:PlanCode;period_months:number;amount_cents:number;external_reference:string;applied_at:string|null};
type Summary = {requests:Request[];renewals:Renewal[];subscription:{plan_code:PlanCode;status:string;period_end:string|null}|null};
const brl=(c:number)=>(c/100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});

export function ManualBillingPanel({companyId}:{companyId:number}) {
  const toast=useToast(),qc=useQueryClient();
  const [plan,setPlan]=useState<PlanCode>("pro"),[months,setMonths]=useState("1");
  const [amount,setAmount]=useState("0"),[reference,setReference]=useState(""),[note,setNote]=useState("");
  const q=useQuery({queryKey:["tigu-manual-billing",companyId],
    queryFn:()=>api.get<Summary>(`/super/companies/${companyId}/manual-billing`),retry:false});
  const renew=useMutation({
    mutationFn:()=>api.post(`/super/companies/${companyId}/manual-renew`,{
      plan_code:plan,period_months:Number(months),amount_cents:Math.round(Number(amount.replace(",","."))*100),
      external_reference:reference.trim(),note:note.trim()
    }),
    onSuccess:()=>{toast.push("ok","Mensalidade registrada e acesso renovado.");setReference("");setNote("");
      void qc.invalidateQueries({queryKey:["tigu-manual-billing",companyId]});
      void qc.invalidateQueries({queryKey:["super-company",companyId]});},
    onError:(e:Error)=>toast.push("err",e.message)
  });
  const reject=useMutation({
    mutationFn:(id:number)=>api.post(`/super/companies/${companyId}/plan-requests/${id}/reject`,{note:"Solicitação rejeitada pelo Super Admin após análise."}),
    onSuccess:()=>{toast.push("ok","Solicitação rejeitada.");void qc.invalidateQueries({queryKey:["tigu-manual-billing",companyId]});},
    onError:(e:Error)=>toast.push("err",e.message)
  });
  if(q.isError) return <section className="mt-5 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-200">
    Gestão manual indisponível. Confirme a migração 0103 no ambiente de homologação e o modo de mensalidades.</section>;
  if(!q.data) return <p className="mt-5 text-xs text-zinc-400">Consultando mensalidades externas…</p>;
  const pending=q.data.requests.filter(r=>r.status==="pending");
  const valid=Number.isInteger(Number(months))&&Number(months)>=1&&Number(months)<=24&&
    /^\d+(?:[.,]\d{1,2})?$/.test(amount)&&Number(amount.replace(",","."))>=0&&
    /^[A-Za-z0-9._-]{8,100}$/.test(reference.trim())&&note.trim().length>=10;
  return <section className="mt-5 rounded-2xl border border-[#35313b] bg-[#16161c] p-5">
    <h2 className="font-display text-lg text-white">Mensalidade externa · controle manual</h2>
    <p className="mt-2 text-xs text-zinc-400">Registre somente pagamentos já conferidos fora do TIGU. Nenhuma cobrança é emitida. Uma referência não pode renovar duas vezes.</p>
    <p className="mt-3 text-xs text-zinc-300">Plano: {q.data.subscription?.plan_code??"—"} · Vencimento: {q.data.subscription?.period_end?new Date(q.data.subscription.period_end).toLocaleDateString("pt-BR"):"—"}</p>
    {pending.map(r=><div key={r.id} className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 p-3 text-xs">
      <span>Solicitação #{r.id} · Plano {r.plan_code.toUpperCase()}</span>
      <div className="flex gap-2">
        <button className="rounded border border-emerald-500/50 p-2 text-emerald-200" onClick={()=>setPlan(r.plan_code)}>Usar plano</button>
        <button className="rounded border border-red-500/50 p-2 text-red-200" disabled={reject.isPending}
          onClick={()=>{if(confirm("Rejeitar esta solicitação de plano?"))reject.mutate(r.id);}}>Rejeitar</button>
      </div>
    </div>)}
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-zinc-300">Plano
        <select className="input-dark mt-1 w-full" value={plan} onChange={e=>setPlan(e.target.value as PlanCode)}>
          <option value="free">Start</option><option value="pro">Pro</option><option value="scale">Scale</option>
        </select>
      </label>
      <label className="text-xs text-zinc-300">Meses a renovar (1–24)
        <input type="number" min={1} max={24} className="input-dark mt-1 w-full" value={months} onChange={e=>setMonths(e.target.value)}/>
      </label>
      <label className="text-xs text-zinc-300">Valor já recebido fora do TIGU (R$)
        <input inputMode="decimal" className="input-dark mt-1 w-full" value={amount} onChange={e=>setAmount(e.target.value)}/>
      </label>
      <label className="text-xs text-zinc-300">Referência única do recebimento
        <input maxLength={100} className="input-dark mt-1 w-full" placeholder="EXTERNO-2026-0001" value={reference} onChange={e=>setReference(e.target.value)}/>
      </label>
      <label className="text-xs text-zinc-300 sm:col-span-2">Justificativa / conferência (mínimo 10 caracteres)
        <textarea rows={2} maxLength={300} className="input-dark mt-1 w-full" value={note} onChange={e=>setNote(e.target.value)}/>
      </label>
    </div>
    <button type="button" disabled={!valid||renew.isPending} onClick={()=>{
      if(confirm(`Confirmar renovação de ${months} mês(es) do plano ${plan.toUpperCase()}? Verifique recebimento externo antes de prosseguir.`))renew.mutate();
    }} className="btn-gold mt-4 rounded-xl px-5 py-3 font-semibold disabled:opacity-50">
      {renew.isPending?"Registrando…":"Registrar pagamento e renovar"}
    </button>
    <h3 className="mt-5 text-sm font-semibold">Últimos registros</h3>
    {q.data.renewals.slice(0,5).map(r=><p key={r.id} className="mt-2 text-xs text-zinc-400">
      {r.external_reference} · {r.plan_code.toUpperCase()} · {r.period_months} mês(es) · {brl(r.amount_cents)} · {r.applied_at?"Aplicado":"Pendente"}
    </p>)}
  </section>;
}
