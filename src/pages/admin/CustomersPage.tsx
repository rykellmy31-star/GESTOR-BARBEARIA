import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Search, ShieldAlert, UserRound } from "lucide-react";
import { api, siteBase } from "@/lib/api";
import { Badge, Button, ConfirmDialog, EmptyState, Input, Modal, Spinner, useToast } from "@/components/ui";
import { fmtDateTime, money } from "@/lib/format";

const TONE: Record<string, any> = { pendente: "amber", confirmado: "green", concluido: "gray", cancelado: "red", no_show: "red" };

export function CustomersPage() {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [openId, setOpenId] = useState<number | null>(null);
  const [anon, setAnon] = useState<any | null>(null);
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ["customers", siteBase(), q], queryFn: () => api.get<any>(`/admin/customers?q=${encodeURIComponent(q)}`).then((d) => d.customers) });
  const detail = useQuery({ queryKey: ["customer", siteBase(), openId], queryFn: () => api.get<any>(`/admin/customers/${openId}`), enabled: Boolean(openId) });

  const anonymize = useMutation({
    mutationFn: (id: number) => api.post<any>(`/admin/customers/${id}/anonymize`, {}),
    onSuccess: (r: any) => { setAnon(null); setOpenId(null); qc.invalidateQueries({ queryKey: ["customers"] }); toast.push("ok", r.message); },
    onError: (e: any) => toast.push("err", e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl text-zinc-50">Clientes</h1>
          <p className="text-xs text-zinc-500">Base construída automaticamente pelos agendamentos (cadastro mínimo, LGPD by design).</p>
        </div>
        <div className="relative w-64">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="nome ou telefone…" className="pl-8" />
        </div>
      </div>

      {list.isLoading && <Spinner />}
      <div className="overflow-hidden rounded-2xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-ink-soft text-left text-[11px] uppercase tracking-wide text-zinc-500">
            <tr><th className="px-4 py-2.5">Cliente</th><th className="px-2 py-2.5">Visitas</th><th className="hidden px-2 py-2.5 sm:table-cell">Concluídas</th><th className="hidden px-2 py-2.5 md:table-cell">Cancel.</th><th className="px-2 py-2.5">Gasto</th><th className="hidden px-2 py-2.5 lg:table-cell">Última visita</th></tr>
          </thead>
          <tbody className="divide-y divide-line bg-panel">
            {(list.data ?? []).map((c: any) => (
              <tr key={c.id} className="cursor-pointer transition-colors hover:bg-gold-soft" onClick={() => setOpenId(c.id)}>
                <td className="px-4 py-2.5">
                  <p className="font-medium text-zinc-100">{c.name ?? <span className="italic text-zinc-500">anônimo (LGPD)</span>}</p>
                  <p className="text-[11px] text-zinc-500">{c.anonymized_at ? "Contato anonimizado" : c.phone}</p>
                </td>
                <td className="px-2 py-2.5 text-zinc-300">{c.visits}</td>
                <td className="hidden px-2 py-2.5 text-zinc-300 sm:table-cell">{c.completed}</td>
                <td className="hidden px-2 py-2.5 text-zinc-500 md:table-cell">{c.canceled}</td>
                <td className="px-2 py-2.5 font-semibold text-[var(--c-gold)]">{money(c.spent_cents)}</td>
                <td className="hidden px-2 py-2.5 text-xs text-zinc-500 lg:table-cell">{c.last_visit ? fmtDateTime(c.last_visit) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.length === 0 && <div className="p-4"><EmptyState icon={<UserRound size={26} />} title="Nenhum cliente encontrado" text="A base cresce a cada reserva on-line — depois de uma semana o gráfico do dashboard começa a contar história." /></div>}
      </div>

      <Modal open={Boolean(openId)} onClose={() => setOpenId(null)} title={detail.data?.customer?.name ?? "Cliente"} wide>
        {!detail.data ? <Spinner /> : (
          <div className="space-y-4 text-sm">
            <div className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-line bg-ink-soft p-3"><p className="text-[11px] uppercase text-zinc-500">Contato</p><p className="text-zinc-200">{detail.data.customer.anonymized_at ? "Contato anonimizado" : detail.data.customer.phone}</p>{detail.data.customer.email && <p className="text-xs text-zinc-400">{detail.data.customer.email}</p>}</div>
              <div className="rounded-xl border border-line bg-ink-soft p-3"><p className="text-[11px] uppercase text-zinc-500">Cliente desde</p><p className="text-zinc-200">{fmtDateTime(detail.data.customer.created_at)}</p></div>
              <div className="rounded-xl border border-line bg-ink-soft p-3"><p className="text-[11px] uppercase text-zinc-500">Reservas</p><p className="text-zinc-200">{detail.data.bookings.length} no histórico</p></div>
            </div>
            <div>
              <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--c-gold)]">Histórico</p>
              <ul className="max-h-64 space-y-1 overflow-y-auto">
                {detail.data.bookings.map((b: any) => (
                  <li key={b.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-[13px]">
                    <span className="font-mono text-[11px] text-zinc-500">{b.code}</span>
                    <span className="flex-1 truncate text-zinc-200">{b.service_name}</span>
                    <span className="text-xs text-zinc-500">{b.barber_name}</span>
                    <span className="text-xs text-zinc-400">{fmtDateTime(b.starts_at)}</span>
                    <Badge tone={TONE[b.status] || "gray"}>{b.status}</Badge>
                    <span className="text-xs text-[var(--c-gold)]">{money(b.price_cents)}</span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="flex items-center justify-between border-t border-line pt-3">
              <p className="max-w-sm text-[11px] leading-relaxed text-zinc-600"><ShieldAlert size={11} className="mr-1 inline text-amber-400" /> Pedido do titular (LGPD art. 18): a anonimização descaracteriza nome/contato mantendo a integridade financeira do histórico.</p>
              {detail.data.customer.anonymized_at ? <Badge tone="gray">Dados anonimizados</Badge> :
                <Button variant="danger" size="sm" onClick={() => setAnon(detail.data.customer)}>Anonimizar dados</Button>}
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog open={Boolean(anon)} onCancel={() => setAnon(null)} onConfirm={() => anon && anonymize.mutate(anon.id)} danger
        title="Anonimizar este cliente?" text="O nome, contato, notas, avaliações e mensagens operacionais serão descaracterizados. Os valores financeiros continuam nos relatórios. Havendo reservas, pedidos ou envios pendentes, a operação será recusada até serem resolvidos. Ação irreversível." />
    </div>
  );
}
