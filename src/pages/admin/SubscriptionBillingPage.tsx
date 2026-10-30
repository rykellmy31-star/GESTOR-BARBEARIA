import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { CreditCard, Copy, CheckCircle2, RefreshCw, ShieldCheck, Clock3 } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui";
import { useAuth } from "@/lib/hooks";
import { ManualSubscriptionView } from "./ManualSubscriptionView";

type PlanCode = "free" | "pro" | "scale";
type Plan = {code:PlanCode;name:string;price_cents_month:number;max_barbers:number;max_messages_month:number;whatsapp_enabled:number;store_enabled:number};
type Invoice = {
  id:number;code:string;plan_code:PlanCode;amount_cents:number;status:"creating"|"pending"|"paid"|"expired"|"failed";
  qr_code_text:string;qr_code_base64:string;expires_at:string|null;paid_at:string|null;
};
type Subscription = {
  plan_code:string;status:string;period_end:string|null;
  name:string;price_cents_month:number;
};
type Summary = {subscription:Subscription|null;invoice:Invoice|null;plans:Plan[];billing_mode?:"manual"|"mercadopago";plan_request?:{id:number;plan_code:string;created_at:string}|null};
const brl=(cents:number)=>(cents/100).toLocaleString("pt-BR",{style:"currency",currency:"BRL"});

export function SubscriptionBillingPage() {
  const toast=useToast();
  const qc=useQueryClient();
  const {refetchMe}=useAuth();
  const [copied,setCopied]=useState(false);
  const [selectedPlan,setSelectedPlan]=useState<PlanCode|null>(null);
  const q=useQuery({
    queryKey:["subscription-billing",location.pathname.split("/")[2]],
    queryFn:()=>api.get<Summary>("/billing/status"),
    refetchInterval:15_000,
  });
  const generate=useMutation({
    mutationFn:(planCode:PlanCode)=>api.post<{invoice:Invoice}>("/billing/pix",{plan_code:planCode}),
    onSuccess:()=>{void q.refetch();toast.push("ok","Pix gerado. Pague usando o código ou QR Code.");},
    onError:(e:Error)=>toast.push("err",e.message)
  });
  const verify=useMutation({
    mutationFn:(invoiceId:number)=>api.post<{status:string;activated:boolean}>("/billing/pix/verify",{invoice_id:invoiceId}),
    onSuccess:async data=>{
      void q.refetch();
      if(data.status==="paid"){
        await refetchMe();
        void qc.invalidateQueries({queryKey:["subscription-billing"]});
        toast.push("ok","Pix confirmado! Assinatura liberada.");
      }else toast.push("ok","Pagamento ainda não confirmado. Aguarde alguns instantes.");
    },
    onError:(e:Error)=>toast.push("err",e.message),
  });
  const sub=q.data?.subscription;
  const invoice=q.data?.invoice;
  const invoiceExpired=Boolean(invoice?.status==="pending" && invoice.expires_at &&
    new Date(invoice.expires_at).getTime() <= Date.now());
  const end=sub?.period_end ? new Date(sub.period_end).getTime() : 0;
  const valid=Number.isFinite(end)&&end>Date.now()&&(sub?.status==="trial"||sub?.status==="active");
  const trial=sub?.status==="trial";
  const amount=sub?.price_cents_month??1999;
  const plans=q.data?.plans??[];
  const chosenCode=selectedPlan??(sub?.plan_code as PlanCode|undefined)??"free";
  const chosen=plans.find(p=>p.code===chosenCode);
  const rank:Record<PlanCode,number>={free:0,pro:1,scale:2};
  const downgradeBlocked=Boolean(valid&&sub?.status==="active"&&rank[chosenCode] < rank[sub?.plan_code as PlanCode]);
  const changing=Boolean(sub&&chosenCode!==sub.plan_code);

  if(q.data?.billing_mode==="manual") return <ManualSubscriptionView data={{subscription:q.data.subscription,plans:q.data.plans,plan_request:q.data.plan_request??null}} />;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link to="../dashboard" className="text-xs text-zinc-400 hover:text-[var(--c-gold)]">← Voltar ao painel</Link>
      <div className="rounded-2xl border border-[var(--c-gold)]/40 bg-[#16161c] p-5 sm:p-8">
        <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[var(--c-gold)]"><CreditCard size={16}/> Assinatura Tigu por Pix</p>
        <h1 className="mt-3 font-display text-2xl text-zinc-50">{trial?"Seu teste grátis de 15 dias":sub?.name??"Assinatura mensal"}</h1>
        {q.isLoading?<p className="mt-5 text-sm text-zinc-400">Consultando sua assinatura…</p>:
         q.isError?<p role="alert" className="mt-5 text-sm text-amber-300">Não foi possível conectar à API. Nenhum pagamento foi iniciado.</p>:
         !sub?<p role="alert" className="mt-5 text-sm text-amber-300">Assinatura não encontrada. Contate o suporte.</p>:
         <>
          <p className="mt-3 text-3xl font-semibold text-zinc-50">{brl(amount)}<span className="ml-1 text-sm font-normal text-zinc-400">/mês</span></p>
          <p className="mt-3 flex gap-2 text-sm text-zinc-300">
            {valid?<CheckCircle2 size={18} className="shrink-0 text-emerald-400"/>:<Clock3 size={18} className="shrink-0 text-amber-400"/>}
            {valid
              ? `Seu acesso está liberado até ${new Date(end).toLocaleDateString("pt-BR")}. ${trial?"Durante os 15 dias você não paga.":""}`
              : "Seu período terminou. Pague a mensalidade via Pix para liberar novamente as operações."}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-zinc-500">
            O valor informado será pago por uma cobrança Pix única. Não haverá débito automático;
            uma nova mensalidade poderá ser paga quando chegar o próximo vencimento. O plano escolhido terá o valor informado antes de gerar o Pix.
          </p>
         </>
        }
      </div>
      {sub && (
        <section className="rounded-2xl border border-[#303039] bg-[#16161c] p-5 sm:p-8">
          <h2 className="font-display text-xl text-zinc-100">
            {valid ? "Escolha ou altere seu plano" : "Seu teste terminou: escolha um plano"}
          </h2>
          <p className="mt-2 text-xs leading-relaxed text-zinc-400">
            Start, Pro e Scale podem ser contratados pelo Pix. O upgrade entra em vigor
            quando o Mercado Pago confirmar o pagamento. O tempo que ainda resta do período
            atual é preservado e o vencimento é prorrogado por um mês, sem abatimento proporcional.
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-3" role="group" aria-label="Selecione seu plano">
            {plans.map(plan=>{
              const selected=chosenCode===plan.code;
              const blocked=Boolean(invoice)||Boolean(valid&&sub?.status==="active"&&rank[plan.code]<rank[sub.plan_code as PlanCode]);
              const name=plan.code==="free"?"Básico · Start":plan.code==="pro"?"Intermediário · Pro":"Premium · Scale";
              return (
                <button key={plan.code} type="button" disabled={blocked}
                  aria-pressed={selected}
                  onClick={()=>setSelectedPlan(plan.code)}
                  className={`rounded-xl border p-4 text-left transition ${selected?"border-[var(--c-gold)] bg-[var(--c-gold)]/10":"border-[#35313b] hover:border-[var(--c-gold)]/60"} disabled:cursor-not-allowed disabled:opacity-50`}>
                  <span className="block text-sm font-semibold text-zinc-100">{name}</span>
                  <span className="mt-1 block text-lg font-semibold text-[var(--c-gold)]">{brl(plan.price_cents_month)}<span className="text-xs text-zinc-400">/mês</span></span>
                  <span className="mt-2 block text-[11px] text-zinc-400">{plan.max_barbers===-1?"Profissionais ilimitados":`${plan.max_barbers} profissionais`}</span>
                  {sub?.plan_code===plan.code&&<span className="mt-2 block text-[11px] text-emerald-300">Plano atual</span>}
                </button>
              );
            })}
          </div>
          {downgradeBlocked&&<p className="mt-3 text-xs text-amber-300">Para reduzir o plano, aguarde o fim do período contratado.</p>}
          {changing&&<p className="mt-3 text-xs text-[#d4af37]">Plano escolhido: {chosen?.name}. Seus recursos mudam somente depois de confirmar o Pix.</p>}
          {invoice?.status==="creating"?<p className="mt-4 text-sm text-zinc-400">Preparando Pix. Atualize esta página em alguns instantes. Não gere vários pagamentos.</p>:
           invoice?.status==="pending"?(
            <div className="mt-4 space-y-4">
              {invoiceExpired ? (
                <p role="alert" className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-sm text-amber-200">
                  O prazo deste QR Code terminou. Não pague o código vencido. Use a verificação abaixo:
                  o Tigu consultará o Mercado Pago antes de permitir gerar outro Pix.
                </p>
              ) : (
                <p className="text-sm text-zinc-300">Pix do plano {invoice.plan_code==="free"?"Start":invoice.plan_code==="pro"?"Pro":"Scale"} de {brl(invoice.amount_cents)} disponível. Faça o pagamento no aplicativo do seu banco e depois confira a confirmação.</p>
              )}
              {!invoiceExpired && invoice.qr_code_base64 && (
                <img alt="QR Code Pix da mensalidade Tigu"
                  className="mx-auto h-52 w-52 rounded-xl bg-white p-2"
                  src={`data:image/png;base64,${invoice.qr_code_base64}`}/>
              )}
              {!invoiceExpired && <label className="block text-xs text-zinc-400">Pix Copia e Cola
                <textarea readOnly rows={4} className="input-dark mt-2 w-full resize-none text-xs"
                  value={invoice.qr_code_text}/>
              </label>}
              {!invoiceExpired && <button type="button" onClick={async ()=>{
                try {await navigator.clipboard.writeText(invoice.qr_code_text);setCopied(true);}
                catch {toast.push("err","Copie o código manualmente.");}
              }} className="btn-gold inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-3 text-sm font-semibold">
                <Copy size={17}/>{copied?"Código copiado!":"Copiar código Pix"}
              </button>}
              {invoice.expires_at && <p className="text-xs text-zinc-500">Validade do QR Code: {new Date(invoice.expires_at).toLocaleString("pt-BR")}.</p>}
              <button type="button" onClick={()=>verify.mutate(invoice.id)} disabled={verify.isPending}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-[var(--c-gold)]/50 px-4 py-3 text-sm text-[var(--c-gold)] disabled:opacity-50">
                <RefreshCw size={16}/>{verify.isPending?"Consultando…":invoiceExpired?"Verificar Pix vencido no Mercado Pago":"Já paguei — verificar no Mercado Pago"}
              </button>
            </div>
           ):(
            <div className="mt-4">
              <p className="mb-4 text-xs text-zinc-400">O pagamento é gerado somente quando você solicitar. Seus dados continuam preservados enquanto não houver pagamento.</p>
              <button type="button" disabled={generate.isPending||q.isLoading||!chosen||downgradeBlocked} onClick={()=>generate.mutate(chosenCode)}
                className="btn-gold inline-flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 font-semibold disabled:opacity-50">
                <CreditCard size={17}/>{generate.isPending?"Gerando Pix…":`Gerar Pix de ${brl(chosen?.price_cents_month??amount)}`}
              </button>
            </div>
           )}
          <div className="mt-5 flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
            <ShieldCheck size={16} className="shrink-0 text-[var(--c-gold)]"/>
            Nunca liberamos a assinatura por comprovante ou clique. O Tigu consulta o Mercado Pago
            e só concede acesso quando o pagamento é aprovado e corresponde à sua fatura.
          </div>
        </section>
      )}
    </div>
  );
}
