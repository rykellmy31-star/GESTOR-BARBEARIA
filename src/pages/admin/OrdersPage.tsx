import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ClipboardList, Phone } from "lucide-react";
import { clsx } from "clsx";
import { api, siteBase } from "@/lib/api";
import { Badge, Button, EmptyState, Spinner, useToast } from "@/components/ui";
import { fmtDateTime, money } from "@/lib/format";

const TONE: Record<string, any> = { novo: "amber", pago: "blue", entregue: "green", cancelado: "red" };
const NEXT: Record<string, { to: string; label: string; kind?: "danger" | "dark" }[]> = {
  novo: [{ to: "pago", label: "Registrar pagamento" }, { to: "cancelado", label: "Cancelar pedido", kind: "danger" }],
  pago: [{ to: "entregue", label: "Marcar entregue" }, { to: "cancelado", label: "Cancelar (devolve estoque)", kind: "danger" }],
  entregue: [],
  cancelado: [],
};

export function OrdersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const q = useQuery({ queryKey: ["orders", siteBase(), status], queryFn: () => api.get<any>(`/admin/orders${status ? `?status=${status}` : ""}`).then((d) => d.orders) });

  const act = useMutation({
    mutationFn: ({ id, to }: { id: number; to: string }) => api.patch(`/admin/orders/${id}/status`, { status: to }),
    onSuccess: (_, v) => { qc.invalidateQueries({ queryKey: ["orders"] }); toast.push("ok", v.to === "pago" ? "Pagamento registrado. O estoque já foi reservado no pedido." : `Pedido ${v.to}.`); },
    onError: (e: any) => toast.push("err", e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl text-zinc-50">Pedidos da loja</h1>
          <p className="text-xs text-zinc-500">Pedidos criados pelo site reservam estoque imediatamente. O pagamento é registrado manualmente pela barbearia.</p>
        </div>
        <div className="flex gap-1 rounded-xl border border-line p-0.5">
          {["", "novo", "pago", "entregue", "cancelado"].map((s) => (
            <button key={s || "all"} onClick={() => setStatus(s)} className={clsx("rounded-lg px-3 py-1.5 text-xs font-semibold", status === s ? "bg-gold-soft text-[var(--c-gold)]" : "text-zinc-400")}>
              {s || "todos"}
            </button>
          ))}
        </div>
      </div>

      {q.isLoading && <Spinner />}
      <ul className="space-y-2">
        {(q.data ?? []).map((o: any) => (
          <li key={o.id} className="rounded-2xl border border-line bg-panel p-4">
            <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 text-left" onClick={() => setOpen(open === o.id ? null : o.id)}>
              <span className="font-mono text-xs text-[var(--c-gold)]">{o.code}</span>
              <span className="font-medium text-zinc-100">{o.customer_name}</span>
              {o.customer_phone && (
                <a href={`https://wa.me/${String(o.customer_phone).replace(/\D/g, "").replace(/^(?!55)/, "55")}`} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1 text-xs text-zinc-400 hover:text-[var(--c-gold)]">
                  <Phone size={11} /> {o.customer_phone}
                </a>
              )}
              <Badge tone={TONE[o.status]}>{o.status}</Badge>
              <span className="text-xs text-zinc-500">{(o.items ?? []).reduce((sum: number, item: {qty:number}) => sum + item.qty, 0)} unidade(s) · {fmtDateTime(o.created_at)}</span>
              <span className="ml-auto flex items-center gap-3">
                <span className="font-display text-lg text-[var(--c-gold)]">{money(o.total_cents)}</span>
                <ChevronDown size={15} className={clsx("text-zinc-500 transition-transform", open === o.id && "rotate-180")} />
              </span>
            </button>
            {open === o.id && (
              <div className="mt-3 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
                <ul className="space-y-1 text-sm">
                  {(o.items ?? []).map((it: any, i: number) => (
                    <li key={i} className="flex justify-between rounded-lg bg-ink-soft px-3 py-1.5">
                      <span className="text-zinc-200">{it.qty}× {it.product_name}</span>
                      <span className="text-zinc-400">{money(it.unit_price_cents * it.qty)}</span>
                    </li>
                  ))}
                </ul>
                <div className="flex flex-col gap-2">
                  {(o.notes && <p className="rounded-lg border border-line p-2.5 text-xs text-zinc-400">Obs.: {o.notes}</p>) || null}
                  {(NEXT[o.status] ?? []).map((a) => (
                    <Button key={a.to} size="sm" variant={a.kind ?? "gold"} disabled={act.isPending} onClick={() => act.mutate({ id: o.id, to: a.to })}>{a.label}</Button>
                  ))}
                  {NEXT[o.status]?.length === 0 && <p className="text-xs text-zinc-500">Pedido finalizado.</p>}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {q.data?.length === 0 && <EmptyState icon={<ClipboardList size={26} />} title="Nenhum pedido neste filtro" text="Assim que um cliente finalizar um carrinho no site, o pedido aparece aqui — e você recebe no sino." />}
    </div>
  );
}
