import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Copy, Loader2, KeyRound } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Field, Input, Select, Spinner, Modal, useToast } from "@/components/ui";
import { H, Kpi, Money, Table, Td, Tr } from "./shared";
import { buildOwnerAccessMessage, formatTrialEnd, type OwnerAccessDetails } from "@/lib/owner-welcome";
import { ManualBillingPanel } from "./ManualBillingPanel";

type OwnerMember = { user_id: number; name: string; email: string; role: string; active: number };

export function SuperCompanyDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["super-co", id], queryFn: () => api.get<any>(`/super/companies/${id}`) });
  const [susp, setSusp] = useState({ mode: "" as "" | "suspend", reason: "" });
  const [accessOpen,setAccessOpen]=useState(false);
  const [selectedOwnerId,setSelectedOwnerId]=useState<number | null>(null);
  const [confirmReset,setConfirmReset]=useState(false);
  const [newPassword,setNewPassword]=useState<string | null>(null);
  const resetOwner=useMutation({
    gcTime:0,
    mutationFn: ({companyId,userId}:{companyId:number;userId:number}) =>
      api.post<{ok:boolean;generated_password:string}>(`/super/companies/${companyId}/owners/${userId}/reset-access`,{}),
    onSuccess: (result) => {
      setNewPassword(result.generated_password);
      setConfirmReset(false);
      toast.push("ok","Nova senha emitida. Copie a mensagem agora: a senha antiga deixou de funcionar.");
    },
    onError: (error: Error) => toast.push("err",error.message),
  });
  const closeAccess=()=>{
    setAccessOpen(false);
    setConfirmReset(false);
    setNewPassword(null);
    resetOwner.reset();
  };
  const mut = useMutation({ mutationFn: (fn: () => Promise<any>) => fn(), onSuccess: () => { toast.push("ok", "Atualizado."); qc.invalidateQueries({ queryKey: ["super-co", id] }); }, onError: (e: any) => toast.push("err", e.message) });

  if (q.isLoading) return <Spinner label="Abrindo empresa…" />;
  if (q.isError || !q.data) return (
    <div role="alert" className="rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">
      Não foi possível carregar o cadastro desta barbearia.
      <button className="ml-2 underline" onClick={() => void q.refetch()}>Tentar novamente</button>
    </div>
  );
  const { company: co, members, connection, jobs, settings, subscription } = q.data;
  const owners=(members as OwnerMember[]).filter(m=>m.role==="owner" && m.active===1);
  // Empresas com vários donos exigem escolha explícita (nunca presumir a conta).
  const owner=owners.find(m=>m.user_id===selectedOwnerId) ??
    (owners.length===1 ? owners[0] : null);
  const accessDetails:OwnerAccessDetails|null=owner?{
    companyName:co.name,ownerName:owner.name,ownerEmail:owner.email,
    slug:co.slug,planCode:subscription?.plan_code ?? co.plan_code,
    subscriptionStatus:subscription?.status ?? null,
    periodEnd:subscription?.period_end ?? null,
    origin:window.location.origin,
    temporaryPassword:newPassword ?? undefined,
  }:null;
  const accessMessage=accessDetails?buildOwnerAccessMessage(accessDetails):"";
  const copyAccess=async()=>{
    try{
      await navigator.clipboard.writeText(accessMessage);
      toast.push("ok","Informações copiadas. Envie em particular ao proprietário.");
    }catch{
      const field=document.getElementById("tigu-owner-details-message") as HTMLTextAreaElement | null;
      field?.focus();field?.select();
      toast.push("info","Selecione a mensagem e use Copiar no seu dispositivo.");
    }
  };

  return (
    <div>
      <Link to="/superadmin/companies" className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"><ArrowLeft size={13} /> barbearias</Link>
      <H title={co.name} sub={<>{co.slug} · criada {new Date(co.created_at).toLocaleDateString("pt-BR")} · {co.bookings_total} agendamentos no total</> as any}
        action={<div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <Button type="button" className="btn-gold" onClick={()=>setAccessOpen(true)}>
            <Copy size={15}/> Copiar informações de login
          </Button>
          <a href={`/c/${co.slug}/admin`} target="_blank" rel="noreferrer"
            className="rounded-lg border border-line px-3 py-2 text-xs text-zinc-300 hover:border-[var(--c-gold)]">
            Consultar painel (somente leitura) ↗
          </a>
        </div>} />
      <Modal open={accessOpen} onClose={closeAccess} title="Informações para o proprietário">
        <div className="space-y-4 text-sm text-zinc-300">
          {owners.length===0 ? (
            <p role="alert" className="rounded-lg border border-amber-500/30 p-3 text-amber-200">
              Esta barbearia ainda não possui proprietário ativo. Cadastre ou reative o proprietário em Membros antes de gerar o convite.
            </p>
          ):(
            <>
              {owners.length>1&&<Field label="Escolha o proprietário">
                <Select value={owner?.user_id ?? ""} onChange={e=>{
                  setSelectedOwnerId(Number(e.target.value)||null);
                  setNewPassword(null);setConfirmReset(false);
                }}>
                  <option value="">Selecione a conta do proprietário</option>
                  {owners.map(m=><option key={m.user_id} value={m.user_id}>{m.name} — {m.email}</option>)}
                </Select>
              </Field>}
              {accessDetails&&<>
                <p className="break-words">Barbearia: <strong>{co.name}</strong></p>
                <p className="break-all">Proprietário: <strong>{owner?.name}</strong> ({owner?.email})</p>
                <p>Plano: <strong>{accessDetails.planCode.toUpperCase()}</strong> · Status: <strong>{accessDetails.subscriptionStatus ?? "Não informado"}</strong></p>
                <p>Validade do período: <strong>{accessDetails.periodEnd ? formatTrialEnd(accessDetails.periodEnd) : "Não informada"}</strong></p>
                <label htmlFor="tigu-owner-details-message" className="block font-medium text-zinc-100">
                  Mensagem com login e link de divulgação
                </label>
                <textarea id="tigu-owner-details-message" readOnly value={accessMessage}
                  onFocus={e=>e.currentTarget.select()} aria-label="Mensagem para o proprietário"
                  className="min-h-64 w-full max-w-full resize-y rounded-xl border border-line bg-[#0a0a0c] p-3 font-mono text-xs leading-relaxed text-zinc-100" />
                <Button type="button" className="btn-gold w-full" onClick={copyAccess}>
                  <Copy size={16}/> Copiar mensagem completa
                </Button>
                {!newPassword && <>
                  <p className="text-xs leading-relaxed text-zinc-400">
                    A senha cadastrada anteriormente não pode ser recuperada. A mensagem acima inclui login, plano,
                    validade e os dois links, sem expor a senha antiga.
                  </p>
                  {confirmReset ? (
                    <div role="alert" className="space-y-3 rounded-xl border border-red-500/40 p-3 text-red-100">
                      <p>Confirma a criação de uma NOVA senha para {owner?.name}? A senha atual e todas as sessões deste usuário deixarão de funcionar, inclusive em outros dispositivos.</p>
                      <div className="flex flex-wrap gap-2">
                        <Button type="button" variant="danger" disabled={resetOwner.isPending}
                          onClick={()=>{if(owner)resetOwner.mutate({companyId:Number(co.id),userId:owner.user_id});}}>
                          {resetOwner.isPending?<Loader2 size={15} className="animate-spin"/>:<KeyRound size={15}/>}
                          Confirmar nova senha
                        </Button>
                        <Button type="button" variant="dark" disabled={resetOwner.isPending}
                          onClick={()=>setConfirmReset(false)}>Cancelar</Button>
                      </div>
                    </div>
                  ):(
                    <Button type="button" variant="dark" onClick={()=>setConfirmReset(true)}>
                      <KeyRound size={15}/> Gerar nova senha provisória
                    </Button>
                  )}
                </>}
                {newPassword&&<p className="rounded-xl border border-amber-500/40 p-3 text-xs leading-relaxed text-amber-200">
                  Nova senha incluída na mensagem. Copie e envie ao proprietário em canal privado agora.
                  Ela desaparecerá ao fechar esta janela; será exigida uma troca no primeiro login.
                </p>}
              </>}
              {!accessDetails&&<p>Escolha um proprietário para montar a mensagem.</p>}
            </>
          )}
          <Button type="button" variant="dark" className="w-full" onClick={closeAccess}>Fechar</Button>
        </div>
      </Modal>
      <div className="grid gap-3 sm:grid-cols-2">
        <Kpi label="Plano" value={co.plan_code} sub={`status: ${co.status}`} />
        <Kpi label="WhatsApp" value={connection?.status ?? "—"} sub={connection?.display_phone || "sem conexão"} tone={connection?.status === "connected" ? "green" : undefined} />
      </div>

      {q.data.billing_mode==="manual" && <ManualBillingPanel companyId={co.id} />}
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
          <h2 className="font-display text-base text-zinc-100">Ações da plataforma</h2>
          <div className="mt-3 space-y-3 text-sm">
            <p className="text-xs text-zinc-400">Para selecionar plano e renovar a assinatura, utilize o quadro de mensalidade externa acima. A alteração é auditada e não gera cobrança.</p>
            {susp.mode === "suspend" ? (
              <Field label="Motivo da suspensão (5+)"><div className="flex gap-2"><Input value={susp.reason} onChange={(e) => setSusp({ ...susp, reason: e.target.value })} className="flex-1" /><Button className="rounded-xl bg-red-500/80 px-4 py-2 text-sm" disabled={susp.reason.length < 5 || mut.isPending} onClick={async () => { await mut.mutateAsync(() => api.post(`/super/companies/${co.id}/suspend`, { reason: susp.reason })); setSusp({ mode: "", reason: "" }); }}>Confirmar</Button></div></Field>
            ) : (
              <div className="flex gap-2">
                {co.status === "active" ? <button className="rounded-lg border border-red-500/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-500/10" onClick={() => setSusp({ mode: "suspend", reason: "" })}>Suspender</button>
                  : <button className="rounded-lg border border-emerald-500/40 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-500/10" onClick={() => mut.mutate(() => api.post(`/super/companies/${co.id}/resume`, {}))}>Reativar</button>}
                <button className="rounded-lg border border-line px-3 py-1.5 text-xs text-zinc-400 hover:border-[var(--c-gold)]" onClick={() => mut.mutate(() => api.post(`/super/companies/${co.id}/seed-demo`, {}))}>Semear demo</button>
              </div>
            )}
            {co.suspend_reason && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-200">Suspensa: {co.suspend_reason}</p>}

          </div>
        </div>

        <div className="space-y-4">
          <div className="rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
            <h2 className="font-display text-base text-zinc-100">Membros ({members.length})</h2>
            <ul className="mt-2 space-y-1.5 text-sm">
              {members.map((m: any) => (
                <li key={m.id} className="flex items-center gap-2"><Badge tone={m.role === "owner" ? "gold" : "gray"}>{m.role}</Badge><span className="text-zinc-200">{m.name}</span><span className="text-xs text-zinc-500">{m.email}</span>{m.active === 0 && <span className="text-[10px] text-zinc-600">inativo</span>}
                  <button className="ml-auto text-[11px] text-zinc-500 hover:text-red-300" onClick={() => mut.mutate(() => api.del(`/super/memberships/${m.id}`))}>revogar</button></li>
              ))}
            </ul>
          </div>
          <div className="rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
            <h2 className="font-display text-base text-zinc-100">Configurações do tenant (leitura)</h2>
            <pre className="mt-2 max-h-40 overflow-auto rounded-xl bg-ink p-3 text-[10px] leading-relaxed text-zinc-400">{JSON.stringify({ currency: settings?.currency, timezone: settings?.timezone, whatsapp_reminders_enabled: settings?.whatsapp_reminders_enabled, reminder_lead_min: settings?.reminder_lead_min, capture_on: settings?.capture_on, slot_min: settings?.slot_min }, null, 1)}</pre>
          </div>
        </div>
      </div>

      <h2 className="mb-2 mt-6 font-display text-base text-zinc-100">Últimos envios</h2>
      <Table head={["#", "Tipo", "Status", "Preço", "Custo", "Capturado", "Estornado"]}>
        {jobs.slice(0, 15).map((j: any) => (
          <Tr key={j.id}><Td>{j.id}</Td><Td>{j.kind}</Td><Td><Badge tone={j.status === "sent" || j.status === "delivered" ? "green" : j.status === "failed" ? "red" : "amber"}>{j.status}</Badge></Td><Td><Money cents={j.price_cents} /></Td><Td><Money cents={j.cost_cents} /></Td><Td className="text-xs">{j.captured_at?.slice(0, 16) ?? "—"}</Td><Td className="text-xs">{j.refunded_at ? "✓" : ""}</Td></Tr>
        ))}
        {jobs.length === 0 && <Tr><Td className="text-zinc-500">Sem envios ainda.</Td><Td /><Td /><Td /><Td /><Td /><Td /></Tr>}
      </Table>
    </div>
  );
}
