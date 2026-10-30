import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Spinner } from "@/components/ui";
import { H, Kpi } from "./shared";

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
  return (
    <div>
      <H title="Visão geral" sub={`Últimos ${d.days} dias · indicadores da plataforma`} action={
        <select value={days} onChange={(e) => setDays(Number(e.target.value))} className="rounded-lg border border-line bg-panel px-3 py-1.5 text-xs text-zinc-300"><option value={7}>7 dias</option><option value={30}>30 dias</option><option value={90}>90 dias</option></select>} />
      <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2">
        <Kpi label="Barbearias ativas" value={d.counts.active} sub={`${d.counts.suspended} suspensas · ${d.counts.created_period} criadas no período`} tone="gold" />
        <Kpi label="Mensagens registradas" value={d.counts.msgs_total} sub="Histórico operacional de notificações" />
      </div>
      <div className="mt-6 grid min-w-0 grid-cols-1 gap-4">
        <div className="min-w-0">
          <h2 className="mb-2 font-display text-base text-zinc-100">Saúde operacional</h2>
          <div className="rounded-2xl border border-[#26262f] bg-[#16161c] p-5 text-sm text-zinc-300">
            <p>Mensagens entregues (histórico): <b>{d.counts.msgs_total}</b></p>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">A fila global roda no cron da plataforma; aqui você também pode <b>forçar um lote</b> (Fila global › rodar agora). Falhas de envio ficam registradas na auditoria para conferência.</p>
          </div>
        </div>
      </div>
    </div>
  );
}
