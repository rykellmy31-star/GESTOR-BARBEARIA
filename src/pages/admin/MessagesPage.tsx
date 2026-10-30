import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, MessageSquare, RefreshCw, Send, Settings2, Smartphone, Unplug } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Field, Input, Modal, Select, Spinner, useToast } from "@/components/ui";
import { money } from "@/lib/format";
import { EvolutionConnectionPanel } from "./EvolutionConnectionPanel";

const STATUS_TONE: Record<string, "gold" | "green" | "red" | "gray" | "amber" | "blue"> = {
  connected: "green", pending_setup: "amber", error: "red", disconnected: "gray",
  scheduled: "amber", sending: "amber", blocked_funds: "amber", sent: "green", delivered: "green", read: "blue", failed: "red", cancelled: "gray", refunded: "gray",
  approved: "green", pending: "amber", rejected: "red", disabled: "gray", unknown: "gray",
};

export function MessagesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["wa"], queryFn: () => api.get<any>("/admin/whatsapp"), refetchInterval: 30_000 });
  const [form, setForm] = useState({ provider: "meta_cloud" as "meta_cloud" | "mock", phone_number_id: "", waba_id: "", access_token: "", display_phone: "", business_name: "", coexistence: "unknown" as "unknown" | "enabled" | "not_eligible" });
  const [editing, setEditing] = useState<any | null>(null);
  const [test, setTest] = useState({ to: "", template: "" });
  const [embed, setEmbed] = useState<{ step: "idle" | "ready" | "paste"; code: string; config_id: string }>({ step: "idle", code: "", config_id: "" });
  const refresh = () => qc.invalidateQueries({ queryKey: ["wa"] });

  const connect = useMutation({
    mutationFn: () => api.post<any>("/admin/whatsapp/connect", form),
    onSuccess: (r) => { r.connected ? toast.push("ok", "WhatsApp conectado e verificado com a Meta.") : toast.push("info", r.message || r.error || "Credenciais salvas; verificação pendente."); refresh(); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const disconnect = useMutation({ mutationFn: () => api.post("/admin/whatsapp/disconnect", {}), onSuccess: () => { toast.push("ok", "Desconectado."); refresh(); }, onError: (e: any) => toast.push("err", e.message) });
  const check = useMutation({ mutationFn: () => api.post<any>("/admin/whatsapp/check", {}), onSuccess: (r) => { toast.push(r.ok ? "ok" : "info", r.message || (r.ok ? "Credenciais válidas." : "A Meta respondeu com erro — veja o detalhe na conexão.")); refresh(); }, onError: (e: any) => toast.push("err", e.message) });
  const syncTpl = useMutation({ mutationFn: () => api.post<any>("/admin/whatsapp/templates/sync", {}), onSuccess: (r) => { toast.push("ok", `${r.synced} template(s) espelhado(s) da Meta.`); refresh(); }, onError: (e: any) => toast.push("err", e.message) });
  const saveTpl = useMutation({
    mutationFn: () => api.put<any>("/admin/whatsapp/templates", { code: editing.code, language: editing.language, body_text: editing.body_text, use_case: editing.use_case, active: editing.active === 1 }),
    onSuccess: (r) => { toast.push("ok", r.message || "Espelho local salvo."); setEditing(null); refresh(); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const sendTest = useMutation({ mutationFn: () => api.post<any>("/admin/whatsapp/test", { to: test.to, ...(test.template ? { template: test.template } : {}) }), onSuccess: (r) => toast.push("ok", r.message || "Teste enfileirado."), onError: (e: any) => toast.push("err", e.message) });
  const runNow = useMutation({ mutationFn: () => api.post<any>("/admin/whatsapp/run-now", {}), onSuccess: (r: any) => { toast.push("ok", `Workers rodaram: ${r.processed ?? 0} job(s).`); refresh(); }, onError: (e: any) => toast.push("err", e.message) });
  const retry = useMutation({ mutationFn: (id: number) => api.post<any>(`/admin/whatsapp/jobs/${id}/retry`, {}), onSuccess: (r) => { toast.push("ok", r.message || "Devolvido à fila."); refresh(); }, onError: (e: any) => toast.push("err", e.message) });
  const embedStart = useMutation({
    mutationFn: () => api.post<any>("/admin/whatsapp/embedded/state", {}),
    onSuccess: (r) => {
      setEmbed({ step: "ready", code: "", config_id: r.config_id });
      const url = `https://developers.facebook.com/dialog/whatsapp_business_embedded_signup?app_id=${r.app_id}&config_id=${r.config_id}&response_type=code`;
      window.open(url, "_blank", "noopener");
    },
    onError: (e: any) => toast.push("info", e.message),
  });
  const embedDone = useMutation({ mutationFn: () => api.post<any>("/admin/whatsapp/embedded/exchange", { code: embed.code, config_id: embed.config_id }), onSuccess: (r) => { toast.push(r.connected ? "ok" : "info", r.connected ? "WABA conectada via Embedded Signup!" : "Código trocado; conexão em pending_setup — rode 'verificar agora'."); setEmbed({ step: "idle", code: "", config_id: "" }); refresh(); }, onError: (e: any) => toast.push("err", e.message) });

  if (q.isLoading) return <Spinner label="Central de mensagens…" />;
  const d = q.data;
  const conn = d.connection;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl text-zinc-50">WhatsApp & automações</h1>
        <p className="mt-1 text-xs text-zinc-500">Envie confirmações e lembretes. A Evolution API não desconta créditos TIGU; a Meta mantém a tarifação atual.</p>
      </div>

      <EvolutionConnectionPanel onChange={refresh} />

      {/* Conexão antiga Meta Cloud API (mantida para compatibilidade) */}
      <div className="rounded-2xl border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center gap-3">
          <Smartphone size={18} className="text-[var(--c-gold)]" />
          <h2 className="font-display text-lg text-zinc-100">Conexão</h2>
          <Badge tone={STATUS_TONE[conn.status] ?? "gray"}>{conn.status === "connected" ? (conn.provider === "mock" ? "simulação ativa" : conn.provider === "evolution" ? "Evolution conectada" : "Meta conectada") : conn.status.replace(/_/g, " ")}</Badge>
          {conn.demo === 1 && <span className="text-[10px] uppercase tracking-[0.25em] text-zinc-500">empresa demo</span>}
          <span className="ml-auto text-xs text-zinc-500">{conn.business_name || ""}{conn.display_phone ? ` · ${conn.display_phone}` : ""}</span>
        </div>
        {conn.last_error && <p className="mt-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">{conn.last_error}</p>}
        <p className="mt-2 text-[11px] text-zinc-500">
          {conn.status === "connected"
            ? <>Última verificação: {conn.last_check_at ? new Date(conn.last_check_at).toLocaleString("pt-BR") : "—"}{conn.provider !== "evolution" ? <> · coexistência com o app Business: <b>{conn.coexistence === "enabled" ? "ativada" : conn.coexistence === "not_eligible" ? "não elegível (use número dedicado)" : "a confirmar"}</b></> : null}</>
            : "Sem conexão real ativa."}
        </p>

        {(conn.status === "disconnected" || conn.status === "error") && conn.provider !== "evolution" ? (
          <div className="mt-4 grid gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-line p-4">
              <p className="text-sm font-semibold text-zinc-200">Modo simulação {d.mock_available ? "" : "(indisponível neste ambiente)"}</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">O fluxo inteiro roda sem enviar nada: lembretes entram na fila e são marcados como <code>sent</code> simulado, com custo zero no extrato.</p>
              <Button className="mt-3 w-full justify-center border border-line py-2 text-sm hover:border-[var(--c-gold)]" disabled={!d.mock_available} onClick={() => { setForm({ ...form, provider: "mock" }); connect.mutate(); }}>Ativar modo simulação</Button>
            </div>
            <div className="rounded-xl border border-line p-4">
              <p className="text-sm font-semibold text-zinc-200">Número real (WhatsApp Cloud API)</p>
              <p className="mt-1 text-xs leading-relaxed text-zinc-500">Do painel da Meta (Phone Number ID + System User token). Salvamos criptografado e validamos na hora contra a Graph API.</p>
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Field label="Phone Number ID"><Input value={form.phone_number_id} onChange={(e) => setForm({ ...form, phone_number_id: e.target.value })} placeholder="123456789012345" /></Field>
                <Field label="WABA ID (opcional)"><Input value={form.waba_id} onChange={(e) => setForm({ ...form, waba_id: e.target.value })} /></Field>
                <div className="col-span-2"><Field label="Token de System User"><Input type="password" value={form.access_token} onChange={(e) => setForm({ ...form, access_token: e.target.value })} placeholder="EAAG…" /></Field></div>
                <Field label="Exibição do número"><Input value={form.display_phone} onChange={(e) => setForm({ ...form, display_phone: e.target.value })} placeholder="+55 75 …" /></Field>
                <Field label="Coexistência com app"><Select value={form.coexistence} onChange={(e) => setForm({ ...form, coexistence: e.target.value as any })}><option value="unknown">ainda não testada</option><option value="enabled">elegível (app continua funcionando)</option><option value="not_eligible">não elegível</option></Select></Field>
              </div>
              <Button className="btn-gold mt-3 w-full justify-center py-2 text-sm" disabled={!form.phone_number_id || form.access_token.length < 20 || connect.isPending} onClick={() => { setForm({ ...form, provider: "meta_cloud" }); connect.mutate(); }}>
                {connect.isPending && <Loader2 size={13} className="mr-1 animate-spin" />}Conectar e verificar
              </Button>
            </div>
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button className="flex items-center gap-1.5 rounded-lg border border-line px-3 py-1.5 text-xs hover:border-[var(--c-gold)]" onClick={() => check.mutate()}>{check.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} verificar agora</Button>
            <button className="inline-flex items-center gap-1 rounded-lg border border-line px-3 py-1.5 text-xs text-zinc-400 hover:border-red-500/60 hover:text-red-300" onClick={() => disconnect.mutate()}><Unplug size={12} /> desconectar</button>
          </div>
        )}

        {/* Embedded signup: exclusivo da Meta */}
        <div className="mt-4 rounded-xl border border-dashed border-line p-4">
          <div className="flex flex-wrap items-center gap-2">
            <p className="flex-1 text-sm text-zinc-300"><b>Onboarding guiado (Embedded Signup)</b> — conectar sem abrir o painel técnico da Meta.</p>
            {d.embedded?.available ? (
              embed.step === "idle" ? <Button className="border border-line py-2 text-sm hover:border-[var(--c-gold)]" onClick={() => embedStart.mutate()}>Iniciar</Button>
              : embed.step === "ready" ? <Button className="btn-gold py-2 text-sm" onClick={() => setEmbed({ ...embed, step: "paste" })}>Já autorizei na Meta →</Button>
              : <Button className="btn-gold py-2 text-sm" disabled={!embed.code || embedDone.isPending} onClick={() => embedDone.mutate()}>{embedDone.isPending && <Loader2 size={12} className="mr-1 animate-spin" />}Concluir conexão</Button>
            ) : (
              <Badge tone="gray">não provisionado nesta instância</Badge>
            )}
          </div>
          {embed.step === "paste" && <div className="mt-2"><Field label="Cole aqui o ?code= que a Meta mostrou no redirect" hint="Ele é trocado por um token de System User e fica criptografado na Tigu."><Input value={embed.code} onChange={(e) => setEmbed({ ...embed, code: e.target.value })} /></Field></div>}
          {!d.embedded?.available && <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">Requer partner config aprovado (WHATSAPP_APP_ID / CONFIG_ID — passo a passo em docs/WHATSAPP.md). Enquanto isso, use a conexão manual ao lado: o fluxo da barbearia é idêntico.</p>}
        </div>
      </div>

      {/* Regras do produto WhatsApp */}
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-sky-500/30 bg-sky-500/5 p-5">
          <h2 className="flex items-center gap-2 font-display text-base text-sky-200"><CheckCircle2 size={16} /> Usar o app do WhatsApp no balcão ao mesmo tempo?</h2>
          <ul className="mt-2 space-y-1.5 text-sm leading-relaxed text-zinc-300">
            <li>✅ <b>Número dedicado para automações</b> (recomendado): a barbearia segue no app de sempre; a Tigu avisa pelo número "agência". Nenhum conflito.</li>
            <li>✅ <b>Coexistência</b>: a Meta permite API + app Business no mesmo número em condições específicas (país, tipo de número, histórico). Marque o resultado do teste no formulário acima; o campo de elegibilidade no connect reflete o que a Meta confirmar.</li>
            <li>⚠️ <b>Janela de 24h</b>: cliente que responde dentro dela recebe texto livre; fora dela, só template aprovado pela Meta. Por isso lembrete/confirmação são templates.</li>
          </ul>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-5">
          <h2 className="flex items-center gap-2 font-display text-base text-zinc-100"><Settings2 size={15} className="text-[var(--c-gold)]" /> Automação desta barbearia</h2>
          <ul className="mt-3 space-y-2 text-sm text-zinc-300">
            <li className="flex justify-between gap-2"><span>Confirmação por WhatsApp</span><Badge tone={d.settings.whatsapp_confirm_enabled ? "green" : "gray"}>{d.settings.whatsapp_confirm_enabled ? "on" : "off"}</Badge></li>
            <li className="flex justify-between gap-2"><span>Lembrete automático</span><Badge tone={d.settings.whatsapp_reminders_enabled ? "green" : "gray"}>{d.settings.whatsapp_reminders_enabled ? `on · ${d.settings.reminder_lead_min} min antes` : "off"}</Badge></li>
            <li className="flex justify-between gap-2"><span>Cobrança capturada em</span><Badge tone="gold">{d.settings.capture_on}</Badge></li>
            <li className="flex justify-between gap-2 text-xs text-zinc-500"><span>templates usados</span><span className="font-mono">{d.settings.reminder_template_code} / {d.settings.confirm_template_code}</span></li>
          </ul>
          <p className="mt-3 flex gap-1.5 rounded-lg border border-line bg-ink-soft px-3 py-2 text-[11px] leading-relaxed text-zinc-400"><Info size={13} className="mt-0.5 shrink-0 text-[var(--c-gold)]" /> Ajuste em <b>Painel › Configurações</b>. O plano atual ({d.plan?.name ?? "Start"}; WhatsApp {d.plan?.whatsapp_enabled ? "habilitado" : "no plano Pro"}, máx. {d.plan?.max_messages_month ?? "∞"} mensagens/mês) limita o envio real — em simulação nada é cobrado.</p>
        </div>
      </div>

      {/* Templates */}
      <div className="rounded-2xl border border-line bg-panel p-5">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex items-center gap-2 font-display text-lg text-zinc-100"><MessageSquare size={17} className="text-[var(--c-gold)]" /> Templates</h2>
          <span className="text-[11px] text-zinc-500">{conn.provider === "evolution" ? "textos editáveis enviados pela Evolution" : "espelho local — o texto que sai é o aprovado na Meta"}</span>
          <Button className="ml-auto flex items-center gap-1.5 border border-line px-3 py-1.5 text-xs hover:border-[var(--c-gold)]" onClick={() => syncTpl.mutate()} disabled={syncTpl.isPending}>{syncTpl.isPending ? <Loader2 size={12} className="animate-spin" /> : <RefreshCw size={12} />} {conn.provider === "evolution" ? "atualizar modelos" : "sincronizar da Meta"}</Button>
        </div>
        <ul className="mt-3 grid gap-2 md:grid-cols-2">
          {(d.templates ?? []).map((t: any) => (
            <li key={`${t.code}-${t.language}`} className="rounded-xl border border-line bg-ink-soft p-3">
              <div className="flex items-center gap-2">
                <span className="font-mono text-xs text-zinc-200">{t.code}</span>
                <Badge tone={STATUS_TONE[t.status] ?? "gray"}>{t.status}</Badge>
                <span className="text-[10px] uppercase text-zinc-500">{t.use_case}</span>
                <button className="ml-auto text-xs text-[var(--c-gold)] hover:underline" onClick={() => setEditing(t)}>{conn.provider === "evolution" ? "editar mensagem" : "editar espelho"}</button>
              </div>
              <p className="mt-1.5 line-clamp-2 text-[11px] leading-relaxed text-zinc-400">{t.body_text || "(texto ainda não sincronizado)"}</p>
            </li>
          ))}
          {(d.templates ?? []).length === 0 && <li className="col-span-2 py-4 text-center text-xs text-zinc-500">Nenhum template espelhado. Crie <code>lembrete_agendamento</code> e <code>confirmacao_agendamento</code> no Business Manager e clique em sincronizar (docs/WHATSAPP.md).</li>}
        </ul>
      </div>

      {/* Teste + jobs */}
      <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
        <div className="space-y-4">
          <div className="rounded-2xl border border-line bg-panel p-5">
            <h2 className="font-display text-base text-zinc-100">Mensagem de teste</h2>
            <div className="mt-3 space-y-2">
              <Field label="Para (WhatsApp)"><Input placeholder="+55 75 99999-0000" value={test.to} onChange={(e) => setTest({ ...test, to: e.target.value })} /></Field>
              <Field label="Template (vazio = o de lembrete do tenant)"><Select value={test.template} onChange={(e) => setTest({ ...test, template: e.target.value })}><option value="">automático</option>{(d.templates ?? []).filter((t: any) => t.active === 1).map((t: any) => <option key={t.code} value={t.code}>{t.code}</option>)}</Select></Field>
              <Button className="btn-gold w-full justify-center py-2 text-sm" disabled={test.to.replace(/\D/g, "").length < 10 || sendTest.isPending} onClick={() => sendTest.mutate()}><Send size={14} /> {sendTest.isPending ? "enviando…" : "enviar teste"}</Button>
            </div>
            <p className="mt-2 text-[11px] text-zinc-500">{conn.provider === "evolution" ? "Evolution API: R$ 0,00 de créditos TIGU por mensagem. Infraestrutura e conexão WhatsApp são externas." : <>Tarifa atual: {money(d.pricing?.price_cents ?? 10)} por mensagem capturada{d.pricing?.source ? ` (fonte: ${d.pricing.source})` : ""}. Testes aparecem na fila com o mesmo custo.</>}</p>
          </div>
          <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-4 text-[11px] leading-relaxed text-amber-100/80">
            <p className="flex gap-1.5"><AlertTriangle size={13} className="mt-0.5 shrink-0" /> O selo azul e limites de envio por dia (100→∞ à medida que a qualidade sobe) são definidos pela Meta, não pela Tigu. Números recém-conectados começam na faixa de 250 conversas/dia em janela de serviço.</p>
          </div>
        </div>
        <div className="rounded-2xl border border-line bg-panel p-5">
          <div className="flex items-center gap-2">
            <h2 className="font-display text-base text-zinc-100">Fila de envios (30 dias: {d.stats?.sent ?? 0} entregues · {d.stats?.charged ?? 0} cobradas)</h2>
            <button className="ml-auto text-xs text-[var(--c-gold)] hover:underline" onClick={() => runNow.mutate()} disabled={runNow.isPending}>{runNow.isPending ? "rodando…" : "rodar workers ↻"}</button>
          </div>
          <ul className="mt-3 max-h-[420px] space-y-1.5 overflow-y-auto pr-1">
            {(d.jobs ?? []).map((j: any) => (
              <li key={j.id} className="flex items-center gap-2 rounded-lg border border-line/70 bg-ink-soft px-2.5 py-1.5 text-xs">
                <Badge tone={j.requires_review ? "red" : (STATUS_TONE[j.status] ?? "gray")}>{j.requires_review ? "verificar envio" : j.status}</Badge>
                <span className="text-zinc-400">{j.kind} → {j.to_phone}</span>
                {j.booking_code && <span className="font-mono text-[10px] text-zinc-600">{j.booking_code}</span>}
                {j.requires_review === 1 && <span className="text-[10px] text-red-300" title={j.last_error || "Resultado desconhecido"}>Sem confirmação da API; não reenviar sem conferir</span>}
                <span className="ml-auto text-[10px] text-zinc-600">{j.scheduled_at ? new Date(j.scheduled_at).toLocaleString("pt-BR", { hour12: false }) : ""}</span>
                {j.price_cents > 0 && <span className="font-mono text-[10px] text-zinc-500">{money(j.price_cents)}</span>}
                {j.status === "failed" && <button className="text-[10px] text-amber-300 hover:underline" onClick={() => retry.mutate(j.id)}>reprocessar</button>}
              </li>
            ))}
            {(d.jobs ?? []).length === 0 && <li className="py-6 text-center text-xs text-zinc-500">Sem envios ainda. Crie um agendamento e o lembrete aparece aqui na fila.</li>}
          </ul>
        </div>
      </div>

      <Modal open={!!editing} onClose={() => setEditing(null)} title={`Espelho local: ${editing?.code ?? ""}`}>
        {editing && (
          <div className="space-y-3">
            <Field label="Texto (use {{1}} {{2}}… em ordem)" hint={conn.provider === "evolution" ? "A Evolution enviará exatamente este texto, respeitando as variáveis." : "Este espelho é só referência no painel; envie a MESMA redação na Meta para aprovação."}>
              <textarea className="h-32 w-full rounded-xl border border-line bg-ink p-2.5 text-sm text-zinc-200" value={editing.body_text} onChange={(e) => setEditing({ ...editing, body_text: e.target.value })} />
            </Field>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Caso de uso"><Select value={editing.use_case} onChange={(e) => setEditing({ ...editing, use_case: e.target.value })}><option value="reminder">lembrete</option><option value="confirmation">confirmação</option><option value="generic">genérico</option></Select></Field>
              <Field label="Ativo"><Select value={String(editing.active === 1)} onChange={(e) => setEditing({ ...editing, active: e.target.value === "true" ? 1 : 0 })}><option value="true">sim</option><option value="false">não</option></Select></Field>
            </div>
            <Button className="btn-gold w-full justify-center py-2.5" onClick={() => saveTpl.mutate()}>Salvar espelho</Button>
          </div>
        )}
      </Modal>
    </div>
  );
}
