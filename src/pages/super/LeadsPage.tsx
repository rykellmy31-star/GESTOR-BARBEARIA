import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Mail, Phone, Search, Save, Trash2, ShieldCheck } from "lucide-react";
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
  const [deleteReason,setDeleteReason]=useState<"privacy_request"|"duplicate"|"no_longer_needed">("privacy_request");
  const save=useMutation({
    mutationFn:()=>api.patch("/super/leads/"+lead.id,{status,internal_note:note}),
    onSuccess:()=>{toast.push("ok","Atendimento atualizado.");reload();},
    onError:(e:Error)=>toast.push("err",e.message)
  });
  const remove=useMutation({
    mutationFn:()=>api.del("/super/leads/"+lead.id,{reason:deleteReason}),
    onSuccess:()=>{toast.push("ok","Dados pessoais do contato excluídos.");reload();},
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
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-[#303039] pt-4">
        <label className="text-xs text-zinc-400">Motivo da exclusão
          <select className="input-dark ml-2" value={deleteReason}
            onChange={e=>setDeleteReason(e.target.value as typeof deleteReason)}>
            <option value="privacy_request">Solicitação do titular</option>
            <option value="duplicate">Contato duplicado</option>
            <option value="no_longer_needed">Não é mais necessário</option>
          </select>
        </label>
        <button type="button" disabled={remove.isPending} onClick={()=>{
          if (window.confirm("Excluir definitivamente os dados deste interessado? Esta ação não pode ser desfeita.")) remove.mutate();
        }} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 px-3 py-2 text-xs text-red-300 hover:bg-red-500/10 disabled:opacity-50">
          <Trash2 size={14} /> Excluir dados do contato
        </button>
      </div>
    </article>
  );
}

function LeadPrivacy() {
  const qc=useQueryClient();
  const toast=useToast();
  const settings=useQuery({
    queryKey:["super-leads-privacy"],
    queryFn:()=>api.get<{retention_days:number}>("/super/leads/privacy")
  });
  const [draft,setDraft]=useState<number|null>(null);
  const chosen=draft ?? settings.data?.retention_days ?? 180;
  const save=useMutation({
    mutationFn:()=>api.put("/super/leads/privacy",{days:chosen}),
    onSuccess:()=>{setDraft(null);void qc.invalidateQueries({queryKey:["super-leads-privacy"]});toast.push("ok","Prazo de retenção atualizado.");},
    onError:(e:Error)=>toast.push("err",e.message)
  });
  const cleanup=useMutation({
    mutationFn:()=>api.post<{removed:number}>("/super/leads/privacy/cleanup",{}),
    onSuccess:(data)=>{toast.push("ok",`Limpeza concluída: ${data.removed} registro(s) vencido(s) excluído(s).`);void qc.invalidateQueries({queryKey:["super-sales-leads"]});},
    onError:(e:Error)=>toast.push("err",e.message)
  });
  return (
    <section className="mb-5 rounded-2xl border border-[#33303a] bg-[#16161c] p-4 sm:p-5" aria-label="Privacidade e retenção comercial">
      <div className="mb-3 flex items-center gap-2 text-zinc-100">
        <ShieldCheck size={18} className="text-[#d4af37]"/>
        <h2 className="font-display text-lg">Privacidade dos contatos</h2>
      </div>
      <p className="mb-4 max-w-3xl text-xs leading-relaxed text-zinc-400">
        Escolha por quanto tempo guardar solicitações comerciais. O padrão inicial é 180 dias.
        Após o prazo, o Worker de produção elimina contatos vencidos diariamente;
        na homologação, a limpeza é manual. Revise a política de retenção antes de receber dados reais.
      </p>
      {settings.isError ? <p role="alert" className="text-xs text-amber-300">Não foi possível carregar a política. Verifique o D1.</p> :
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-zinc-300">Guardar contatos por
            <select className="input-dark mt-1.5 block min-w-[140px]" disabled={settings.isLoading} value={chosen}
              onChange={e=>setDraft(Number(e.target.value))}>
              {[30,90,180,365].map(n=><option value={n} key={n}>{n} dias</option>)}
            </select>
          </label>
          <button type="button" disabled={save.isPending || settings.isLoading || chosen===settings.data?.retention_days}
            onClick={()=>save.mutate()} className="btn-gold rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
            Salvar prazo
          </button>
          <button type="button" disabled={cleanup.isPending || settings.isLoading} onClick={()=>{
            if(window.confirm("Excluir os contatos com prazo vencido? Até 200 registros serão removidos nesta execução.")) cleanup.mutate();
          }} className="rounded-xl border border-[#454047] px-4 py-2.5 text-sm text-zinc-200 hover:border-[#d4af37]/50 disabled:opacity-50">
            Limpar contatos vencidos
          </button>
        </div>}
    </section>
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
      <LeadPrivacy />
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
