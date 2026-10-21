import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Spinner } from "@/components/ui";
import { H, Kpi, Money, Table, Td, Tr } from "./shared";

export function SuperOverview() {
  const [days, setDays] = useState(30);
  const q = useQuery({ queryKey: ["super-overview", days], queryFn: () => api.get<any>(`/super/overview?days=${days}`) });
  if (q.isLoading) return <Spinner label="Consolidando a plataforma…" />;
  if (q.isError || !q.data) {
    return (
      <div role="alert" className="rounded-2xl border border-amber-500/30 bg-[#16161c] p-6">
        <h1 className="font-display text-xl text-zinc-100">Não foi possível carregar o painel</h1>
        <p className="mt-2 text-sm text-zinc-400">Confira se a API e o banco D1 do Tigu estão configurados neste ambiente.</p>
        <button type="button" onClick={() => void q.refetch()}
          className="mt-4 rounded-xl border border-[#d4af37]/60 px-4 py-2 text-sm font-semibold text-[#e8ca66] hover:bg-[#d4af37]/10">
          Tentar novamente
        </button>
      </div>
    );
  }
  const d = q.data;
  const usage = (d.usage_by_day ?? []).slice().reverse();
  const maxRev = Math.max(1, ...usage.map((u: any) => Number(u.revenue_cents ?? 0)));
  return (
    <div>
      <H title="Visão geral" sub={`Últimos ${d.days} dias · receita de mensagens líquida do custo do provedor`} action={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-line bg-panel px-3 py-1.5 text-xs text-zinc-300"><option value={7}>7 dias</option><option value={30}>30 dias</option><option value={90}>90 dias</option></select>} />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Barbearias ativas" value={d.counts.active} sub={`${d.counts.suspended} suspensas · ${d.counts.created_period} criadas no período`} tone="gold" />
        <Kpi label="Receita de mensagens" value={d.finance.consumption_cents != null ? <Money cents={d.finance.consumption_cents} /> : 0} sub={`${d.topups.n} recargas pagas · ${money0(d.topups.cents)} no período`} />
        <Kpi label="Custo provedor" value={<Money cents={d.finance.provider_cost_cents} />} sub={`Refunds: ${money0(d.finance.refund_cents)}`} />
        <Kpi label="Margem bruta" value={<Money cents={d.finance.gross_margin_cents} />} sub={`${d.finance.margin_pct}% · float retido em carteiras: ${money0(d.finance.float_held_cents)}`} tone="green" />
      </div>
      <p className="mt-3 text-[11px] text-zinc-500">{d.note_revenue}</p>
      <div className="mt-6 rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
        <h2 className="font-display text-base text-zinc-100">Mensagens cobradas por dia</h2>
        <div className="mt-4 flex h-36 items-end gap-1">
          {usage.map((u: any) => (
            <div key={u.day} className="group relative flex-1 rounded-t bg-[color-mix(in_srgb,var(--c-gold)_55%,transparent)] transition-colors hover:bg-[var(--c-gold)]" style={{ height: `${Math.max(3, (Number(u.revenue_cents) / maxRev) * 100)}%` }}>
              <span className="pointer-events-none absolute -top-8 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-2 py-1 text-[10px] text-zinc-200 group-hover:block">{u.day}: {u.msgs} msgs · {money0(u.revenue_cents)}</span>
            </div>
          ))}
          {usage.length === 0 && <p className="text-xs text-zinc-500">Sem cobranças capturadas no período.</p>}
        </div>
      </div>
      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <div>
          <h2 className="mb-2 font-display text-base text-zinc-100">Top barbearias por receita de mensagens</h2>
          <Table head={["Empresa", "Msgs/mês", "Saldo carteira"]}>
            {(d.usageTop ?? []).map((r: any) => <Tr key={r.id}><Td>{r.name}</Td><Td><Money cents={r.revenue_cents} /></Td><Td><Money cents={r.balance_cents} /></Td></Tr>)}
          </Table>
          <p className="mt-1.5 text-[10px] text-zinc-600">Detalhamento por empresa está em Barbearias › (clique).</p>
        </div>
        <div>
          <h2 className="mb-2 font-display text-base text-zinc-100">Saúde operacional</h2>
          <div className="rounded-2xl border border-[#26262f] bg-[#16161c] p-5 text-sm text-zinc-300">
            <p>Mensagens entregues (histórico): <b>{d.counts.msgs_total}</b></p>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">A fila global roda no cron da plataforma; aqui você também pode <b>forçar um lote</b> (Fila global › rodar agora). Falhas com retry esgotado ficam visíveis na auditoria e viram crédito automático à barbearia.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
function money0(c: number | string | null | undefined) { return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(c ?? 0) / 100); }
