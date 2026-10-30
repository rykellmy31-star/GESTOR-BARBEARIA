import { useState } from "react";
import { Loader2, MessageSquare, RefreshCw, Send, Settings2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Field, Input, Modal, Select, Spinner, useToast } from "@/components/ui";
import { EvolutionConnectionPanel } from "./EvolutionConnectionPanel";

const STATUS_TONE: Record<string, "gold" | "green" | "red" | "gray" | "amber" | "blue"> = {
  connected: "green", pending_setup: "amber", error: "red", disconnected: "gray",
  scheduled: "amber", sending: "amber", blocked_funds: "amber",
  sent: "green", delivered: "green", read: "blue", failed: "red",
  skipped: "gray", cancelled: "gray", refunded: "gray",
  approved: "green", pending: "amber", rejected: "red", disabled: "gray", unknown: "gray",
};

export function MessagesPage() {
  const qc=useQueryClient(), toast=useToast();
  const q=useQuery({queryKey:["wa"],queryFn:()=>api.get<any>("/admin/whatsapp"),refetchInterval:30_000});
  const [editing,setEditing]=useState<any|null>(null);
  const [test,setTest]=useState({to:"",template:""});
  const refresh=()=>qc.invalidateQueries({queryKey:["wa"]});

  const saveTpl=useMutation({
    mutationFn:()=>api.put<any>("/admin/whatsapp/templates",{
      code:editing.code,language:editing.language,body_text:editing.body_text,
      use_case:editing.use_case,active:editing.active===1,
    }),
    onSuccess:(r)=>{toast.push("ok",r.message||"Texto salvo.");setEditing(null);refresh();},
    onError:(e:any)=>toast.push("err",e.message),
  });
  const sendTest=useMutation({
    mutationFn:()=>api.post<any>("/admin/whatsapp/test",{
      to:test.to,...(test.template?{template:test.template}:{})
    }),
    onSuccess:(r)=>{toast.push("ok",r.message||"Teste processado.");refresh();},
    onError:(e:any)=>toast.push("err",e.message),
  });
  const runNow=useMutation({
    mutationFn:()=>api.post<any>("/admin/whatsapp/run-now",{}),
    onSuccess:(r)=>{toast.push("ok",`Fila processada: ${r.processed??0} mensagem(ns).`);refresh();},
    onError:(e:any)=>toast.push("err",e.message),
  });
  const retry=useMutation({
    mutationFn:(id:number)=>api.post<any>(`/admin/whatsapp/jobs/${id}/retry`,{}),
    onSuccess:()=>{toast.push("ok","Mensagem devolvida à fila.");refresh();},
    onError:(e:any)=>toast.push("err",e.message),
  });
  if(q.isLoading) return <Spinner label="Central de mensagens…" />;
  if(q.isError||!q.data) return <p className="text-sm text-red-300">Não foi possível carregar o WhatsApp. Atualize a página.</p>;
  const d=q.data;

  return <div className="space-y-5">
    <div>
      <h1 className="font-display text-2xl text-zinc-50">WhatsApp — Evolution API</h1>
      <p className="mt-1 text-xs text-zinc-400">A única integração de WhatsApp do TIGU. Cada barbearia conecta seu número via QR Code. Envios de agendamento pela Evolution.</p>
    </div>
    <EvolutionConnectionPanel onChange={refresh} />

    <div className="rounded-2xl border border-line bg-panel p-5">
      <h2 className="flex items-center gap-2 font-display text-base text-zinc-100"><Settings2 size={16}/> Automações desta barbearia</h2>
      <div className="mt-3 grid gap-2 text-xs text-zinc-300 md:grid-cols-2">
        <p>Confirmação: <Badge tone={d.settings.whatsapp_confirm_enabled?"green":"gray"}>{d.settings.whatsapp_confirm_enabled?"ativada":"desativada"}</Badge></p>
        <p>Lembrete: <Badge tone={d.settings.whatsapp_reminders_enabled?"green":"gray"}>{d.settings.whatsapp_reminders_enabled?`ativo · ${d.settings.reminder_lead_min} min antes`:"desativado"}</Badge></p>
        <p>Plano: {d.plan?.name??"—"}</p>
        <p>Limite: {d.plan?.max_messages_month===-1?"ilimitado":d.plan?.max_messages_month??"—"} mensagens/mês</p>
      </div>
      <p className="mt-3 text-xs text-zinc-500">Altere os horários, confirmação e lembrete em Configurações. O envio respeita o consentimento do cliente e o plano contratado.</p>
    </div>

    <div className="rounded-2xl border border-line bg-panel p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 font-display text-base text-zinc-100"><MessageSquare size={17}/> Textos automáticos</h2>
        <span className="text-xs text-zinc-500">Mensagens editáveis usadas exclusivamente pela Evolution API</span>
      </div>
      <ul className="mt-3 grid gap-2 md:grid-cols-2">
        {(d.templates??[]).map((t:any)=><li key={`${t.code}-${t.language}`} className="rounded-xl border border-line bg-ink-soft p-3">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs text-zinc-200">{t.code}</span>
            <Badge tone={STATUS_TONE[t.status]??"gray"}>{t.status}</Badge>
            <button className="ml-auto text-xs text-[var(--c-gold)] hover:underline" onClick={()=>setEditing(t)}>editar texto</button>
          </div>
          <p className="mt-2 line-clamp-2 text-xs text-zinc-400">{t.body_text||"(sem texto)"}</p>
        </li>)}
        {(d.templates??[]).length===0&&<li className="py-3 text-sm text-zinc-400">Os modelos de confirmação e lembrete são criados automaticamente ao iniciar a Evolution API.</li>}
      </ul>
    </div>

    <div className="grid gap-4 lg:grid-cols-[1fr_1.3fr]">
      <div className="rounded-2xl border border-line bg-panel p-5">
        <h2 className="font-display text-base text-zinc-100">Mensagem de teste</h2>
        <div className="mt-3 space-y-3">
          <Field label="Número com DDI e DDD"><Input placeholder="+55 75 99999-0000" value={test.to} onChange={e=>setTest({...test,to:e.target.value})}/></Field>
          <Field label="Texto (vazio usa lembrete)">
            <Select value={test.template} onChange={e=>setTest({...test,template:e.target.value})}>
              <option value="">lembrete padrão</option>
              {(d.templates??[]).filter((t:any)=>t.active===1).map((t:any)=><option key={t.code} value={t.code}>{t.code}</option>)}
            </Select>
          </Field>
          <Button className="btn-gold w-full justify-center py-2 text-sm" disabled={test.to.replace(/\D/g,"").length<10||sendTest.isPending||d.connection.status!=="connected"||d.connection.provider!=="evolution"} onClick={()=>sendTest.mutate()}>
            <Send size={14}/>{sendTest.isPending?"enviando…":"Enviar teste"}
          </Button>
        </div>
      </div>
      <div className="rounded-2xl border border-line bg-panel p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="font-display text-base text-zinc-100">Histórico de envios ({d.stats?.sent??0} enviados)</h2>
          <button className="flex items-center gap-1 text-xs text-[var(--c-gold)]" onClick={()=>runNow.mutate()} disabled={runNow.isPending}>
            {runNow.isPending?<Loader2 size={13} className="animate-spin"/>:<RefreshCw size={13}/>} Processar fila
          </button>
        </div>
        <ul className="mt-3 max-h-[420px] space-y-2 overflow-y-auto">
          {(d.jobs??[]).map((j:any)=><li key={j.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line/70 bg-ink-soft px-3 py-2 text-xs">
            <Badge tone={STATUS_TONE[j.status]??"gray"}>{j.status}</Badge>
            <span className="text-zinc-400">{j.kind} → {j.to_phone}</span>
            {j.provider!=="evolution"&&<span className="text-[10px] text-zinc-500">histórico anterior</span>}
            {j.requires_review===1&&<span className="text-red-300">Verificar envio; sem confirmação</span>}
            <span className="ml-auto text-[10px] text-zinc-500">{j.scheduled_at?new Date(j.scheduled_at).toLocaleString("pt-BR"):""}</span>
            {j.provider==="evolution"&&j.status==="failed"&&<button className="text-amber-300" onClick={()=>retry.mutate(j.id)}>Reprocessar</button>}
          </li>)}
          {(d.jobs??[]).length===0&&<li className="py-5 text-center text-xs text-zinc-500">Nenhuma mensagem registrada.</li>}
        </ul>
      </div>
    </div>

    <Modal open={!!editing} onClose={()=>setEditing(null)} title={`Editar texto: ${editing?.code??""}`}>
      {editing&&<div className="space-y-3">
        <Field label="Texto da mensagem" hint="Use {{1}}, {{2}}, {{3}} etc. para preencher os dados do agendamento.">
          <textarea className="h-36 w-full rounded-xl border border-line bg-ink p-2.5 text-sm text-zinc-200" value={editing.body_text} onChange={e=>setEditing({...editing,body_text:e.target.value})}/>
        </Field>
        <Field label="Uso"><Select value={editing.use_case} onChange={e=>setEditing({...editing,use_case:e.target.value})}>
          <option value="reminder">Lembrete</option><option value="confirmation">Confirmação</option><option value="generic">Outro</option>
        </Select></Field>
        <Field label="Ativo"><Select value={String(editing.active===1)} onChange={e=>setEditing({...editing,active:e.target.value==="true"?1:0})}>
          <option value="true">Sim</option><option value="false">Não</option>
        </Select></Field>
        <Button className="btn-gold w-full justify-center py-2" disabled={saveTpl.isPending||editing.body_text?.length<5} onClick={()=>saveTpl.mutate()}>Salvar texto</Button>
      </div>}
    </Modal>
  </div>;
}
