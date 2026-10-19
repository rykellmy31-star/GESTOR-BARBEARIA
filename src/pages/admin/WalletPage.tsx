import { useState } from "react";
import { Check, Copy, CreditCard, Loader2, QrCode, Wallet as WalletIcon, X } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, EmptyState, Field, Input, Modal, Spinner, useToast } from "@/components/ui";
import { money } from "@/lib/format";

const PRESETS = [1000, 2500, 5000, 10000];
const STATUS_TONE: Record<string, "gold" | "green" | "red" | "gray" | "amber" | "blue"> = { paid: "green", pending: "amber", expired: "gray", cancelled: "gray", failed: "red" };

export function WalletPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["wallet"], queryFn: () => api.get<any>("/admin/wallet"), refetchInterval: 30_000 });
  const [amount, setAmount] = useState<number>(2500);
  const [custom, setCustom] = useState("");
  const [checkout, setCheckout] = useState<any | null>(null);

  const create = useMutation({
    mutationFn: () => api.post<any>("/admin/wallet/topup", { amount_cents: amount }),
    onSuccess: (r) => { setCheckout({ ...r.topup, mock: r.mock }); toast.push("ok", "Cobrança Pix gerada. Pague para creditar os créditos."); qc.invalidateQueries({ queryKey: ["wallet"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const simu = useMutation({
    mutationFn: (code: string) => api.post<any>(`/admin/wallet/topup/${code}/simulate`, {}),
    onSuccess: (r) => { r.credited ? toast.push("ok", "Pagamento simulado — créditos adicionados (ambiente de demonstração).") : toast.push("err", r.note || "Não foi possível creditar"); refreshCheckout(); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const cancel = useMutation({
    mutationFn: (code: string) => api.post(`/admin/wallet/topup/${code}/cancel`, {}),
    onSuccess: () => { setCheckout(null); qc.invalidateQueries({ queryKey: ["wallet"] }); toast.push("ok", "Cobrança cancelada."); },
    onError: (e: any) => toast.push("err", e.message),
  });

  const refreshCheckout = async () => {
    if (!checkout?.code) return;
    try {
      const fresh = await api.get<any>(`/admin/wallet/topup/${checkout.code}`);
      setCheckout(fresh.topup);
      qc.invalidateQueries({ queryKey: ["wallet"] });
      if (fresh.topup.status === "paid") toast.push("ok", "Pix aprovado — créditos na carteira!");
    } catch { /* rede */ }
  };

  if (q.isLoading) return <Spinner label="Abrindo carteira…" />;
  const d = q.data;
  const w = d?.wallet;
  const effPrice = d?.pricing?.price_cents ?? 10;
  const selected = custom ? Math.round(Number(custom.replace(",", ".")) * 100) : amount;
  const valid = Number.isFinite(selected) && selected >= 1000 && selected <= 100000;

  return (
    <div className="space-y-5">
      <div>
        <h1 className="font-display text-2xl text-zinc-50">Carteira de créditos</h1>
        <p className="mt-1 text-xs text-zinc-500">Saldo e reservas vivem no servidor (nunca só no navegador). Crédito entra <b>somente</b> com Pix confirmado pelo gateway.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Kpi label="Saldo disponível" value={money(Math.max(0, (w?.balance_cents ?? 0) - (w?.reserved_cents ?? 0)))} sub={`${Math.floor(Math.max(0, (w?.balance_cents ?? 0) - (w?.reserved_cents ?? 0)) / effPrice)} mensagens possíveis · R$ ${(effPrice / 100).toFixed(2)} cada`} gold />
        <Kpi label="Reservado (envios na fila)" value={money(w?.reserved_cents ?? 0)} sub="valor empenhado; liberado se o envio falhar" />
        <Kpi label="Gasto com mensagens" value={money(w?.lifetime_charged_cents ?? 0)} sub={`recargas: ${money(w?.lifetime_recharged_cents ?? 0)}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-2xl border border-line bg-panel p-5">
          <h2 className="flex items-center gap-2 font-display text-lg text-zinc-100"><QrCode size={17} className="text-[var(--c-gold)]" /> Recarregar créditos (Pix)</h2>
          <div className="mt-4 flex flex-wrap gap-2">
            {PRESETS.map((p) => (
              <button key={p} onClick={() => { setAmount(p); setCustom(""); }} className={`rounded-xl border px-4 py-2 text-sm font-semibold ${!custom && amount === p ? "border-[var(--c-gold)] bg-gold-soft text-[var(--c-gold)]" : "border-line text-zinc-300 hover:border-[var(--c-gold)]"}`}>{money(p)}</button>
            ))}
          </div>
          <div className="mt-3">
            <Field label="Ou valor personalizado (R$)" hint="Entre R$ 10,00 e R$ 1.000,00 por recarga.">
              <Input inputMode="decimal" placeholder="ex.: 35,00" value={custom} onChange={(e) => setCustom(e.target.value)} />
            </Field>
          </div>
          <Button className="btn-gold mt-4 w-full justify-center py-3" disabled={!valid || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 size={15} className="animate-spin" /> : <CreditCard size={15} />} Pagar {money(valid ? selected : 0)} via Pix
          </Button>
          {!d?.payments_available && <p className="mt-3 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-200">Pix automático indisponível neste ambiente. Peça o crédito ao suporte Tigu — a equipe credita com registro auditado.</p>}
        </div>

        <div className="rounded-2xl border border-line bg-panel p-5">
          <h2 className="font-display text-lg text-zinc-100">Recargas recentes</h2>
          <ul className="mt-3 space-y-2">
            {(d?.topups ?? []).slice(0, 8).map((t: any) => (
              <li key={t.code} className="flex items-center gap-2 rounded-xl border border-line bg-ink-soft px-3 py-2 text-sm">
                <span className="font-mono text-[11px] text-zinc-500">{t.code}</span>
                <span className="flex-1 font-semibold text-zinc-100">{money(t.amount_cents)}</span>
                <Badge tone={STATUS_TONE[t.status] ?? "gray"}>{t.status}</Badge>
                {t.status === "pending" && <button className="text-xs text-[var(--c-gold)] hover:underline" onClick={() => setCheckout(t)}>abrir pix</button>}
              </li>
            ))}
            {(d?.topups ?? []).length === 0 && <p className="py-6 text-center text-sm text-zinc-500">Sem recargas ainda.</p>}
          </ul>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-panel">
        <div className="flex items-center gap-2 border-b border-line px-5 py-3"><WalletIcon size={16} className="text-[var(--c-gold)]" /><h2 className="font-display text-base text-zinc-100">Extrato (imutável)</h2></div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-zinc-500"><th className="px-5 py-2.5">Quando</th><th className="px-5 py-2.5">Tipo</th><th className="px-5 py-2.5">Nota</th><th className="px-5 py-2.5 text-right">Valor</th><th className="px-5 py-2.5 text-right">Saldo após</th></tr></thead>
            <tbody>
              {(d?.transactions ?? []).map((t: any, i: number) => (
                <tr key={i} className="border-b border-line/50 last:border-0">
                  <td className="px-5 py-2 text-xs text-zinc-500">{new Date(t.created_at).toLocaleString("pt-BR")}</td>
                  <td className="px-5 py-2"><Badge tone={t.type === "topup" ? "green" : t.type === "capture" ? "red" : "gray"}>{t.type}</Badge></td>
                  <td className="max-w-[300px] truncate px-5 py-2 text-xs text-zinc-400">{t.note}</td>
                  <td className={`px-5 py-2 text-right font-mono ${t.amount_cents >= 0 ? "text-emerald-300" : "text-red-300"}`}>{t.amount_cents >= 0 ? "+" : ""}{money(t.amount_cents)}</td>
                  <td className="px-5 py-2 text-right font-mono text-zinc-300">{money(t.balance_after)}</td>
                </tr>
              ))}
              {(d?.transactions ?? []).length === 0 && <tr><td colSpan={5} className="px-5 py-8 text-center text-sm text-zinc-500">Sem lançamentos — a primeira recarga abre o extrato.</td></tr>}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-3 text-[11px] text-zinc-500">Gasto no mês (mensagens cobradas): <b className="text-zinc-300">{money(d?.month_spend_cents ?? 0)}</b>. A cobrança só ocorre quando o provedor aceita o envio; falha definitiva nunca é cobrada e estorno pós-entrega é creditado automaticamente.</p>
      </div>

      <Modal open={!!checkout} onClose={() => setCheckout(null)} title="Pagamento Pix">
        {checkout && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-300">Pedido <b className="font-mono">{checkout.code}</b> · {money(checkout.amount_cents)} em créditos.</p>
            {checkout.qr_code_base64 && <img src={`data:image/png;base64,${checkout.qr_code_base64}`} alt="QR Code Pix" className="mx-auto h-48 w-48 rounded-xl border border-line bg-white p-2" />}
            {checkout.qr_code_text && (
              <div>
                <p className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">Pix copia-e-cola</p>
                <textarea readOnly className="h-24 w-full rounded-xl border border-line bg-ink p-2 font-mono text-[11px] text-zinc-300" value={checkout.qr_code_text} onFocus={(e) => e.target.select()} />
                <Button className="mt-2 w-full justify-center border border-line py-2 text-sm" onClick={() => { navigator.clipboard?.writeText(checkout.qr_code_text); toast.push("ok", "Código Pix copiado."); }}><Copy size={14} /> Copiar</Button>
              </div>
            )}
            {checkout.status === "pending" ? (
              <>
                <p className="flex items-center gap-2 text-xs text-amber-300"><Loader2 size={13} className="animate-spin" /> Aguardando confirmação do banco… <button onClick={refreshCheckout} className="underline">verificar agora</button></p>
                {(checkout.mock === true || checkout.provider === "mock") && (
                  <Button className="w-full justify-center border border-sky-500/50 py-2.5 text-sm text-sky-200" onClick={() => simu.mutate(checkout.code)}>Simular pagamento aprovado (demo)</Button>
                )}
                <button className="flex w-full items-center justify-center gap-1 text-xs text-zinc-500 hover:text-red-300" onClick={() => cancel.mutate(checkout.code)}><X size={12} /> cancelar cobrança</button>
              </>
            ) : (
              <p className="flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200"><Check size={15} /> Status: {checkout.status} — créditos {checkout.credited_at ? "já creditados ✓" : ""}</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

function Kpi({ label, value, sub, gold }: any) {
  return (
    <div className="card-luxe rounded-2xl border border-line bg-panel p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1.5 font-display text-[26px] leading-none ${gold ? "gold-text" : "text-zinc-50"}`}>{value}</p>
      {sub && <p className="mt-1.5 text-[11px] text-zinc-500">{sub}</p>}
    </div>
  );
}
