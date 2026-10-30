import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { AlertTriangle, FileClock, RefreshCcw, Search, ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";
import { H, Kpi, Money } from "./shared";

type Status = "creating" | "pending" | "paid" | "expired" | "failed";
type Invoice = {
  id: number;
  code: string;
  company_id: number;
  company_name: string;
  slug: string;
  plan_code: string;
  amount_cents: number;
  status: Status;
  provider_payment_id: string | null;
  expires_at: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
};
type Summary = {
  total: number;
  paid_count: number;
  paid_cents: number;
  pending_count: number;
  creating_count: number;
  closed_count: number;
};
type InvoicesResponse = { invoices: Invoice[]; summary: Summary; limit: number };

const labels: Record<Status, string> = {
  creating: "Em criação",
  pending: "Aguardando Pix",
  paid: "Pago / confirmado",
  expired: "Vencido",
  failed: "Falhou",
};
const color: Record<Status, string> = {
  creating: "text-amber-200 border-amber-500/30 bg-amber-500/10",
  pending: "text-amber-200 border-amber-500/30 bg-amber-500/10",
  paid: "text-emerald-300 border-emerald-500/30 bg-emerald-500/10",
  expired: "text-zinc-400 border-zinc-500/30 bg-zinc-500/10",
  failed: "text-red-300 border-red-500/30 bg-red-500/10",
};

const labelPlan = (code: string) =>
  code === "free" ? "Start" : code === "pro" ? "Pro" : code === "scale" ? "Scale" : code;
const date = (value: string | null) => value ? new Date(value).toLocaleString("pt-BR") : "—";

export function SuperSubscriptionInvoices() {
  const [status, setStatus] = useState("");
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("");
  const results = useQuery({
    queryKey: ["super-subscription-invoices", status, filter],
    queryFn: () => api.get<InvoicesResponse>(
      `/super/subscription-invoices?status=${encodeURIComponent(status)}&q=${encodeURIComponent(filter)}`
    ),
    refetchInterval: 30_000,
  });
  const summary = results.data?.summary;
  const list = results.data?.invoices ?? [];
  return (
    <div>
      <H title="Histórico de faturas Pix" sub="Faturas Pix anteriores do TIGU. A partir do modo manual, renovações externas são registradas no cadastro da barbearia; recargas do WhatsApp permanecem separadas." action={
        <button onClick={() => void results.refetch()} type="button"
          className="inline-flex items-center gap-2 rounded-xl border border-[#35313b] px-3 py-2 text-xs text-zinc-300 hover:text-[#d4af37]">
          <RefreshCcw size={15}/> Atualizar
        </button>
      } />
      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi label="Total confirmado" value={<Money cents={summary?.paid_cents} />} tone="green" sub="Soma histórica das faturas aprovadas" />
        <Kpi label="Faturas pagas" value={summary?.paid_count ?? "—"} sub="Confirmação Mercado Pago" />
        <Kpi label="Pix pendentes" value={summary?.pending_count ?? "—"} sub="Aguardando pagamento" tone="gold" />
        <Kpi label="Precisam de atenção" value={summary ? summary.creating_count + summary.closed_count : "—"} sub="Em criação, vencidas ou falhas" />
      </div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <form className="min-w-[220px] flex-1" onSubmit={e => { e.preventDefault(); setFilter(search.trim().slice(0, 80)); }}>
          <label className="text-xs text-zinc-400" htmlFor="subscription-invoice-search">Buscar por empresa ou código</label>
          <div className="mt-1.5 flex gap-2">
            <input id="subscription-invoice-search" value={search}
              onChange={e => setSearch(e.target.value)} maxLength={80}
              className="input-dark w-full" placeholder="Barbearia ou código da fatura" />
            <button className="rounded-xl border border-[#35313b] px-3 text-zinc-200 hover:border-[#d4af37]" type="submit" aria-label="Buscar faturas"><Search size={17}/></button>
          </div>
        </form>
        <label className="text-xs text-zinc-400">
          Situação
          <select value={status} onChange={e => setStatus(e.target.value)} className="input-dark mt-1.5 block min-w-[185px]">
            <option value="">Todas</option>
            {(Object.keys(labels) as Status[]).map(key => <option value={key} key={key}>{labels[key]}</option>)}
          </select>
        </label>
      </div>
      {results.isLoading ? <p className="text-sm text-zinc-400">Carregando cobranças Pix…</p>
        : results.isError ? <div role="alert" className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-200">
          Não foi possível carregar as faturas. Confira a migration 0005 e o banco D1 do Tigu.
        </div>
        : list.length === 0 ? <p className="rounded-xl border border-[#35313b] p-5 text-sm text-zinc-400">Nenhuma fatura encontrada para este filtro.</p>
        : <div className="space-y-3">
          {list.map(invoice => {
            const needsReview = invoice.status === "creating" &&
              Date.now() - new Date(invoice.created_at).getTime() > 10 * 60_000;
            return (
              <article key={invoice.id} className="rounded-2xl border border-[#35313b] bg-[#16161c] p-4 sm:p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <Link to={`/superadmin/companies/${invoice.company_id}`}
                      className="font-display text-lg text-zinc-100 hover:text-[#d4af37]">{invoice.company_name}</Link>
                    <p className="mt-1 text-xs text-zinc-500">{invoice.slug} · Fatura #{invoice.id} · Plano {labelPlan(invoice.plan_code)}</p>
                    <p className="mt-2 break-all font-mono text-[11px] text-zinc-500">{invoice.code}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-lg font-semibold text-zinc-100"><Money cents={invoice.amount_cents}/></p>
                    <span className={`mt-1 inline-block rounded-full border px-2.5 py-1 text-[11px] font-semibold ${color[invoice.status]}`}>{labels[invoice.status]}</span>
                  </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-zinc-400">
                  <span>Criada: {date(invoice.created_at)}</span>
                  {invoice.expires_at && <span>Vencimento Pix: {date(invoice.expires_at)}</span>}
                  {invoice.paid_at && <span>Pagamento: {date(invoice.paid_at)}</span>}
                  {invoice.provider_payment_id && <span>ID Mercado Pago: {invoice.provider_payment_id}</span>}
                </div>
                {needsReview && <p className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-200">
                  <AlertTriangle className="shrink-0" size={15}/> Criação pendente há mais de 10 minutos: verificar no Mercado Pago antes de qualquer nova fatura.
                </p>}
              </article>
            );
          })}
        </div>
      }
      <p className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
        <FileClock size={15} className="shrink-0"/> Mostrando até {results.data?.limit ?? 100} faturas recentes por filtro. Os indicadores representam todas as faturas, não apenas as exibidas.
      </p>
      <p className="mt-2 flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
        <ShieldCheck size={15} className="shrink-0 text-[#d4af37]"/>
        Esta tela é somente de consulta. Nenhum botão aceita comprovante, marca Pix como pago ou altera acesso. Apenas a confirmação conferida na API do Mercado Pago pode ativar assinaturas.
      </p>
    </div>
  );
}
