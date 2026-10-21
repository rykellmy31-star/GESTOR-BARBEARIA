import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Loader2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Field, Input, Select, Spinner, useToast } from "@/components/ui";
import { money } from "@/lib/format";
import { H, Kpi, Money, Table, Td, Tr } from "./shared";

export function SuperCompanyDetail() {
  const { id } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["super-co", id], queryFn: () => api.get<any>(`/super/companies/${id}`) });
  const [adj, setAdj] = useState({ delta: "", why: "" });
  const [susp, setSusp] = useState({ mode: "" as "" | "suspend", reason: "" });
  const mut = useMutation({ mutationFn: (fn: () => Promise<any>) => fn(), onSuccess: () => { toast.push("ok", "Atualizado."); qc.invalidateQueries({ queryKey: ["super-co", id] }); }, onError: (e: any) => toast.push("err", e.message) });

  if (q.isLoading) return <Spinner label="Abrindo empresa…" />;
  if (q.isError || !q.data) return (
    <div role="alert" className="rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">
      Não foi possível carregar o cadastro desta barbearia.
      <button className="ml-2 underline" onClick={() => void q.refetch()}>Tentar novamente</button>
    </div>
  );
  const { company: co, members, connection, wallet, jobs, settings } = q.data;

  return (
    <div>
      <Link to="/superadmin/companies" className="mb-3 inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-zinc-200"><ArrowLeft size={13} /> barbearias</Link>
      <H title={co.name} sub={<>{co.slug} · criada {new Date(co.created_at).toLocaleDateString("pt-BR")} · {co.bookings_total} agendamentos no total</> as any} action={<a href={`/c/${co.slug}/admin`} target="_blank" className="rounded-lg border border-line px-3 py-1.5 text-xs text-zinc-300 hover:border-[var(--c-gold)]">abrir painel (assumido) ↗</a>} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Saldo" value={<Money cents={wallet?.balance_cents} />} sub={`reservado ${money(wallet?.reserved_cents ?? 0)}`} tone="gold" />
        <Kpi label="Plano" value={co.plan_code} sub={`status: ${co.status}`} />
        <Kpi label="WhatsApp" value={connection?.status ?? "—"} sub={connection?.display_phone || "sem conexão"} tone={connection?.status === "connected" ? "green" : undefined} />
        <Kpi label="Política carteira" value={wallet?.allow_negative ? "permite negativo" : "saldo ≥ 0"} sub={`alerta baixo: ${money(wallet?.low_balance_alert_cents ?? 0)}`} />
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
          <h2 className="font-display text-base text-zinc-100">Ações da plataforma</h2>
          <div className="mt-3 space-y-3 text-sm">
            <Field label="Alterar plano"><div className="flex gap-2"><Select value={co.plan_code} onChange={(e) => mut.mutate(() => api.put(`/super/companies/${co.id}/plan`, { plan_code: e.target.value, note: "ajuste via suíte" }))} className="flex-1"><option value="free">free</option><option value="pro">pro</option><option value="scale">scale</option></Select></div></Field>
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
            <div className="border-t border-[#26262f] pt-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Ajuste manual de créditos (justificativa vai p/ auditoria)</p>
              <div className="mt-2 flex gap-2">
                <Input placeholder="ex.: 5000 ou -1250 (centavos)" value={adj.delta} onChange={(e) => setAdj({ ...adj, delta: e.target.value })} className="w-40" />
                <Input placeholder="Justificativa (10+ chars)" value={adj.why} onChange={(e) => setAdj({ ...adj, why: e.target.value })} className="flex-1" />
                <Button className="btn-gold px-4 py-2 text-sm" disabled={!/^-?\d{3,}$/.test(adj.delta.trim()) || adj.why.trim().length < 10 || mut.isPending} onClick={async () => { try { await mut.mutateAsync(() => api.post(`/super/wallets/${co.id}/adjust`, { delta_cents: Number(adj.delta), justification: adj.why.trim() })); setAdj({ delta: "", why: "" }); } catch { /* onError já exibe falha; manter dados para correção */ } }}>Aplicar</Button>
              </div>
              <button className="mt-2 text-[11px] text-zinc-500 hover:text-zinc-300" onClick={() => mut.mutate(() => api.put(`/super/wallets/${co.id}/policy`, { allow_negative: !wallet?.allow_negative }))}>
                {wallet?.allow_negative ? "Reverter política: bloquear saldo negativo" : "Liberar saldo negativo para esta empresa (uso raro)"}
              </button>
            </div>
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
