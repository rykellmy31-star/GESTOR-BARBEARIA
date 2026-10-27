import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Activity, BarChart3, CalendarPlus, ClipboardList, Scissors, Timer, TrendingUp, Users, Wallet } from "lucide-react";
import { clsx } from "clsx";
import { api, siteBase } from "@/lib/api";
import { useConfig } from "@/lib/hooks";
import { Badge, Spinner } from "@/components/ui";
import { fmtTime, money } from "@/lib/format";

export function DashboardPage() {
  const { data: cfg } = useConfig();
  const tz = cfg?.settings.timezone || "America/Bahia";
  const [days, setDays] = useState(7);
  const { from, to } = useMemo(() => {
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - (days - 1));
    return { from: d.toISOString().slice(0, 10), to: today };
  }, [days, tz]);
  const q = useQuery({ queryKey: ["dashboard", siteBase(), from, to], queryFn: () => api.get<any>(`/admin/dashboard?from=${from}&to=${to}`) });
  if (q.isLoading) return <Spinner label="Carregando indicadores…" />;
  if (q.isError || !q.data) return (
    <div role="alert" className="rounded-xl border border-amber-500/40 bg-panel p-5 text-sm text-amber-200">
      Não foi possível carregar o dashboard. Nenhum dado foi alterado.
      <button className="ml-2 underline" onClick={() => void q.refetch()}>Tentar novamente</button>
    </div>
  );
  const d = q.data;
  const k = d.kpis;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-zinc-50">Visão geral</h1>
          <p className="text-xs text-zinc-500">Período {d.period.from} → {d.period.to} · timezone {tz}</p>
        </div>
        <div className="flex items-center gap-1 rounded-xl border border-line p-1">
          {[1, 7, 14, 30].map((n) => (
            <button key={n} onClick={() => setDays(n)} className={clsx("rounded-lg px-3 py-1.5 text-xs font-semibold", days === n ? "bg-gold-soft text-[var(--c-gold)]" : "text-zinc-400 hover:text-zinc-100")}>{n === 1 ? "Hoje" : `${n}d`}</button>
          ))}
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={<CalendarPlus size={16} />} label={`Agendamentos (${k.today_label})`} value={k.total_today} sub={`${k.pending} pendentes · ${k.confirmed} confirmados`} />
        <Kpi icon={<Wallet size={16} />} label="Faturamento realizado" value={money(k.revenue_realized_cents)} sub={`serviços ${money(k.revenue_bookings_cents)} + loja ${money(k.revenue_products_cents)}`} gold />
        <Kpi icon={<TrendingUp size={16} />} label="Previsão (próximos)" value={money(k.revenue_forecast_cents)} sub="valor de reservas pendentes/confirmadas" />
        <Kpi icon={<Activity size={16} />} label="Disponíveis hoje" value={k.available_today} sub={`${k.active_barbers} barbeiros ativos · ${k.customers} clientes`} />
      </div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi icon={<Scissors size={16} />} label="Concluídos no período" value={k.completed} sub={`${k.no_show} no-show · ${k.canceled} cancelados`} />
        <Kpi icon={<ClipboardList size={16} />} label="Pedidos da loja" value={k.open_orders} sub={`${k.units_sold} unidades vendidas no período`} />
        <Kpi icon={<Users size={16} />} label="Clientes na base" value={k.customers} sub="LGPD: anonimização sob pedido" />
        <Kpi icon={<Timer size={16} />} label="Antecedência mínima" value={`${cfg?.settings.min_lead_min ?? 60} min`} sub={`janela de ${cfg?.settings.horizon_days ?? 30} dias · passos de ${cfg?.settings.slot_step_min ?? 15} min`} />
      </div>

      {/* gráfico de série */}
      <div className="rounded-2xl border border-line bg-panel p-5">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="flex items-center gap-2 font-display text-lg text-zinc-100"><BarChart3 size={17} className="text-[var(--c-gold)]" /> Atendimentos & faturamento</h2>
          <span className="flex items-center gap-3 text-[11px] text-zinc-500">
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-zinc-500" /> agendamentos</span>
            <span className="flex items-center gap-1"><i className="h-2 w-2 rounded-sm bg-[var(--c-gold)]" /> receita (R$)</span>
          </span>
        </div>
        <BarChart series={d.series} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* próximos */}
        <div className="rounded-2xl border border-line bg-panel p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-lg text-zinc-100">Próximos atendimentos</h2>
            <Link to={siteBase() + "/admin/agenda"} className="text-xs text-[var(--c-gold)] hover:underline">abrir agenda →</Link>
          </div>
          <ul className="space-y-2">
            {d.upcoming.map((u: any) => (
              <li key={u.id} className="flex items-center gap-3 rounded-xl border border-line bg-ink-soft px-3 py-2 text-sm">
                <span className="font-mono text-[11px] text-zinc-500">{fmtTime(u.starts_at, tz)}</span>
                <span className="min-w-0 flex-1 truncate text-zinc-200">{u.customer_name} <span className="text-zinc-500">· {u.service_name}</span></span>
                <Badge tone={u.status === "confirmado" ? "green" : "amber"}>{u.status}</Badge>
                <span className="hidden text-xs text-zinc-500 sm:block">{u.barber_name}</span>
              </li>
            ))}
            {!d.upcoming.length && <p className="py-6 text-center text-sm text-zinc-500">Nada agendado ainda. Divulgue o link /agendar!</p>}
          </ul>
        </div>
        {/* disponibilidade por barbeiro */}
        <div className="rounded-2xl border border-line bg-panel p-5">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-lg text-zinc-100">Vagas livres hoje, por barbeiro</h2>
            <Link to={siteBase() + "/admin/barbeiros"} className="text-xs text-[var(--c-gold)] hover:underline">equipe →</Link>
          </div>
          <ul className="space-y-2">
            {d.availability_by_barber.map((a: any) => (
              <li key={a.barber_id} className="flex items-center gap-3 text-sm">
                <span className="w-32 truncate text-zinc-300">{a.name}</span>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-ink-soft">
                  <div className="h-full rounded-full bg-gradient-to-r from-[var(--c-gold)]/50 to-[var(--c-gold)]" style={{ width: `${Math.min(100, a.available_today * 8)}%` }} />
                </div>
                <span className={clsx("w-16 text-right text-xs font-semibold", a.available_today === 0 ? "text-red-400" : "text-[var(--c-gold)]")}>{a.available_today === 0 ? "lotado" : `${a.available_today} vagas`}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 border-t border-line pt-3 text-[11px] text-zinc-600">Contagem real pelo mesmo motor de disponibilidade usado pelo site — não é estatística decorativa.</p>
        </div>
      </div>
    </div>
  );
}

function Kpi({ icon, label, value, sub, gold }: any) {
  return (
    <div className="card-luxe rounded-2xl border border-line bg-panel p-4">
      <p className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{icon} {label}</p>
      <p className={clsx("mt-1.5 font-display text-[26px] font-semibold leading-none", gold ? "gold-text" : "text-zinc-50")}>{value}</p>
      {sub && <p className="mt-1.5 text-[11px] text-zinc-500">{sub}</p>}
    </div>
  );
}

/** gráfico de barras desenhado à mão (sem libs externas) */
function BarChart({ series }: { series: { day: string; bookings: number; revenue: number }[] }) {
  const maxB = Math.max(1, ...series.map((s) => s.bookings));
  const maxR = Math.max(1, ...series.map((s) => s.revenue));
  const w = 100 / Math.max(1, series.length);
  return (
    <div>
      <svg viewBox={`0 0 100 ${44}`} preserveAspectRatio="none" className="h-40 w-full">
        {[0, 11, 22, 33, 44].map((y) => <line key={y} x1="0" x2="100" y1={y} y2={y} stroke="#26262f" strokeWidth="0.35" />)}
        {series.map((s, i) => {
          const bh = (s.bookings / maxB) * 40;
          const rh = (s.revenue / maxR) * 40;
          const x = i * w;
          return (
            <g key={s.day}>
              <rect x={x + w * 0.12} y={44 - bh} width={w * 0.32} height={bh} rx="0.8" fill="#8b8b95" opacity=".55" />
              <rect x={x + w * 0.52} y={44 - rh} width={w * 0.32} height={rh} rx="0.8" fill="var(--c-gold)" opacity=".9" />
              <title>{`${s.day}: ${s.bookings} atendimentos · R$ ${s.revenue.toFixed(0)}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-600">
        {series.map((s) => <span key={s.day}>{s.day.slice(8)}/{s.day.slice(5, 7)}</span>)}
      </div>
    </div>
  );
}
