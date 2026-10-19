import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Phone, Search, Save } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui";
import { H } from "./shared";
import { money } from "@/lib/format";

type Status = "new" | "contacted" | "negotiating" | "closed";
const statuses: Record<Status,string> = {
  new:"Novo",contacted:"Contato realizado",negotiating:"Em negociação",closed:"Encerrado"
};
type Lead = {id:number;contact_name:string;company_name:string;email:string;phone:string;
  plan_code:"pro"|"scale";price_snapshot_cents:number;message:string;status:Status;
  internal_note:string;consent_at:string;created_at:string;updated_at:string};

function LeadCard({ lead, reload }: {lead:Lead;reload:()=>void}) {
  const toast=useToast();
  const [status,setStatus]=useState(lead.status);
  const [note,setNote]=useState(lead.internal_note);
  const save=useMutation({
    mutationFn:()=>api.patch("/super/leads/"+lead.id,{status,internal_note:note}),
    onSuccess:()=>{toast.push("ok","Atendimento atualizado.");reload();},
    onError:(e:Error)=>toast.push("err",e.message)
  });
  const phone=lead.phone.replace(/\D/g,"");
  return (
    <article className="rounded-2xl border border-[#33303a] bg-[#16161c] p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-lg text-zinc-100">{lead.company_name}</h2>
          <p className="mt-1 text-xs text-zinc-400">{lead.contact_name} · Plano {lead.plan_code.toUpperCase()}</p>
          <p className="mt-1 text-[11px] text-zinc-500">Solicitado em {new Date(lead.created_at).toLocaleString("pt-BR")} · mensalidade de referência: {money(lead.price_snapshot_cents)}</p>
        </div>
        <span className="rounded-full border border-[#d4af37]/30 bg-[#d4af37]/10 px-2.5 py-1 text-xs text-[#e8ca66]">{statuses[lead.status]}</span>
      </div>
      <div className="mt-4 flex flex-wrap gap-3 text-xs">
        <a className="inline-flex items-center gap-1.5 text-[#d4af37] hover:underline" href={`mailto:${lead.email}`}><Mail size={14}/>{lead.email}</a>
        <a className="inline-flex items-center gap-1.5 text-[#d4af37] hover:underline" href={`https://wa.me/${phone}`} target="_blank" rel="noopener noreferrer"><Phone size={14}/>{lead.phone}</a>
      </div>
      {lead.message && <p className="mt-3 rounded-xl bg-[#101014] p-3 text-xs leading-relaxed text-zinc-300">{lead.message}</p>}
      <div className="mt-4 grid gap-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
        <label className="text-xs text-zinc-400">Andamento
          <select className="input-dark mt-1.5 w-full" value={status} onChange={e=>setStatus(e.target.value as Status)}>
            {(Object.keys(statuses) as Status[]).map(key=><option key={key} value={key}>{statuses[key]}</option>)}
          </select>
        </label>
        <label className="text-xs text-zinc-400">Nota interna (não visível ao cliente)
          <input className="input-dark mt-1.5 w-full" maxLength={500} value={note} onChange={e=>setNote(e.target.value)} placeholder="Ex.: pediu retorno na sexta-feira"/>
        </label>
        <button type="button" disabled={save.isPending || (status===lead.status && note===lead.internal_note)}
          onClick={()=>save.mutate()} className="btn-gold inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50"><Save size={15}/> Salvar</button>
      </div>
    </article>
  );
}

export function SuperLeads() {
  const qc=useQueryClient();
  const [status,setStatus]=useState("");
  const [query,setQuery]=useState("");
  const results=useQuery({
    queryKey:["super-sales-leads",status,query],
    queryFn:()=>api.get<{leads:Lead[]}>(`/super/leads?status=${encodeURIComponent(status)}&q=${encodeURIComponent(query)}`),
  });
  return (
    <div>
      <H title="Interessados nos planos" sub="Solicitações comerciais recebidas do site. Nenhum registro confirma pagamento ou ativa assinatura."/>
      <div className="mb-5 flex flex-wrap gap-3">
        <label className="relative min-w-[220px] flex-1 text-xs text-zinc-400">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"/>
          <input className="input-dark w-full pl-9" aria-label="Buscar interessados" placeholder="Nome, barbearia ou e-mail…" value={query} onChange={e=>setQuery(e.target.value)}/>
        </label>
        <select aria-label="Filtrar por andamento" className="input-dark min-w-[180px]" value={status} onChange={e=>setStatus(e.target.value)}>
          <option value="">Todos os atendimentos</option>{(Object.keys(statuses) as Status[]).map(key=><option key={key} value={key}>{statuses[key]}</option>)}
        </select>
      </div>
      {results.isLoading ? <p className="text-sm text-zinc-400">Carregando solicitações…</p> :
        results.isError ? <div role="alert" className="rounded-xl border border-amber-500/30 p-4 text-sm text-amber-200">Não foi possível carregar interessados. Verifique se a migration 0003 foi aplicada.
          <button className="ml-2 underline" onClick={()=>void results.refetch()}>Tentar novamente</button>
        </div> :
        (results.data?.leads.length ?? 0)===0 ? <p className="rounded-xl border border-[#33303a] p-5 text-sm text-zinc-400">Nenhuma solicitação encontrada para este filtro.</p> :
        <div className="space-y-3">{results.data!.leads.map(l=><LeadCard key={l.id} lead={l} reload={()=>{void qc.invalidateQueries({queryKey:["super-sales-leads"]});}}/>)}</div>}
      <p className="mt-5 text-xs text-zinc-500">Contatos são exibidos somente no Superadmin. O registro do andamento não gera cobrança e não altera o plano da barbearia.</p>
    </div>
  );
}
