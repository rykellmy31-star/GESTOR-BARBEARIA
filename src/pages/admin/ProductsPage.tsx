import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Boxes, Pencil, Plus, Sparkle, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import { api, siteBase } from "@/lib/api";
import { Badge, Button, ConfirmDialog, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, useToast } from "@/components/ui";
import { ImageUpload } from "@/components/ui/Upload";
import { money, toCents } from "@/lib/format";

type F = { id?: number; name: string; description: string; price_reais: string; stock: number; category: string; photo: string; active: boolean; featured: boolean; adjust_stock_by: number; stock_reason: string };
const BLANK: F = { name: "", description: "", price_reais: "", stock: 0, category: "cuidados", photo: "", active: true, featured: false, adjust_stock_by: 0, stock_reason: "" };
const CATS = ["cuidados", "finalizacao", "acessorios", "kits", "bebe", "outro"];

export function ProductsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["admin-products", siteBase()], queryFn: () => api.get<any>("/admin/products").then((d) => d.products) });
  const [edit, setEdit] = useState<F | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [onlyLow, setOnlyLow] = useState(false);

  const save = useMutation({
    mutationFn: (f: F) => {
      const body: any = { name: f.name, description: f.description, price_cents: toCents(f.price_reais), stock: f.stock, category: f.category, photo: f.photo, active: f.active, featured: f.featured };
      if (f.adjust_stock_by) { body.adjust_stock_by = f.adjust_stock_by; body.stock_reason = f.stock_reason || "ajuste manual"; }
      return f.id ? api.put(`/admin/products/${f.id}`, body) : api.post("/admin/products", body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-products"] }); qc.invalidateQueries({ queryKey: ["tenant", siteBase(), "products"] }); setEdit(null); toast.push("ok", "Produto salvo."); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del<any>(`/admin/products/${id}`),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["admin-products"] }); qc.invalidateQueries({ queryKey: ["tenant", siteBase(), "products"] }); setDel(null); toast.push("ok", r?.message || "Desativado."); },
    onError: (e: any) => toast.push("err", e.message),
  });

  const rows = (list.data ?? []).filter((p: any) => (onlyLow ? p.stock <= 3 : true));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-display text-2xl text-zinc-50">Produtos & Estoque</h1>
          <p className="text-xs text-zinc-500">Reserva de estoque ao criar pedido; registro manual de pagamento e estorno ao cancelar.</p>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setOnlyLow((v) => !v)} className={clsx("rounded-lg border px-3 py-1.5 text-xs", onlyLow ? "border-amber-500/60 bg-amber-500/10 text-amber-300" : "border-line text-zinc-400")}>
            <AlertTriangle size={12} className="mr-1 inline" /> estoque baixo (≤3)
          </button>
          <Button size="sm" onClick={() => setEdit({ ...BLANK })}><Plus size={14} /> Novo produto</Button>
        </div>
      </div>

      {list.isLoading && <Spinner />}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {rows.map((p: any) => (
          <article key={p.id} className={clsx("card-luxe rounded-2xl border bg-panel p-3.5", p.stock <= 3 ? "border-amber-500/40" : "border-line", !p.active && "opacity-55")}>
            <div className="flex gap-3">
              {p.photo ? <img src={p.photo} alt="" className="h-16 w-16 rounded-xl object-cover" /> : <div className="grid h-16 w-16 place-items-center rounded-xl bg-ink-soft text-zinc-600"><Boxes size={20} /></div>}
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1 text-sm font-semibold text-zinc-100">{p.name} {p.featured ? <Sparkle size={12} className="text-[var(--c-gold)]" /> : null} {p.demo ? <Badge tone="gray">demo</Badge> : null}</p>
                <p className="text-[11px] text-zinc-500">{p.category} · {money(p.price_cents)}</p>
                <p className="mt-1"><Badge tone={p.stock === 0 ? "red" : p.stock <= 3 ? "amber" : "green"}>{p.stock} em estoque</Badge>{!p.active && <span className="ml-1.5 text-[10.5px] text-zinc-500">inativo</span>}</p>
              </div>
            </div>
            <p className="mt-2 line-clamp-2 text-[12px] text-zinc-500">{p.description}</p>
            <div className="mt-2.5 flex gap-1.5 border-t border-line pt-2.5">
              <Button size="sm" variant="dark" onClick={() => setEdit({ id: p.id, name: p.name, description: p.description, price_reais: (Number(p.price_cents) / 100).toFixed(2), stock: p.stock, category: p.category, photo: p.photo, active: !!p.active, featured: !!p.featured, adjust_stock_by: 0, stock_reason: "" })}><Pencil size={13} /> Editar / movimentar</Button>
              <Button size="sm" variant="danger" className="ml-auto" onClick={() => setDel(p)}><Trash2 size={13} /></Button>
            </div>
          </article>
        ))}
      </div>
      {list.data?.length === 0 && <EmptyState icon={<Boxes size={26} />} title="Nenhum produto" text="Cadastre pomadas, óleos e kits para vender pela vitrine do site." action={<Button size="sm" onClick={() => setEdit({ ...BLANK })}>Criar produto</Button>} />}
      {rows.length === 0 && list.data?.length > 0 && <p className="text-center text-sm text-zinc-500">Nenhum item com estoque baixo 🎉</p>}

      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? "Editar produto" : "Novo produto"} wide>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <Field label="Nome" required><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Descrição"><Textarea value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Preço (R$)"><Input inputMode="decimal" value={edit.price_reais} onChange={(e) => setEdit({ ...edit, price_reais: e.target.value })} placeholder="89,90" /></Field>
                <Field label="Estoque" hint={edit.id ? "ou use a movimentação ↓" : undefined}><Input type="number" min={0} value={edit.stock} disabled={Boolean(edit.id)} onChange={(e) => setEdit({ ...edit, stock: Number(e.target.value) })} /></Field>
                <Field label="Categoria"><Select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
              </div>
              {edit.id && (
                <div className="rounded-xl border border-line bg-ink-soft p-3">
                  <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--c-gold)]">Movimentação de estoque (entra no histórico)</p>
                  <div className="grid grid-cols-2 gap-2">
                    <Field label="Δ entradas/saídas"><Input type="number" value={edit.adjust_stock_by} onChange={(e) => setEdit({ ...edit, adjust_stock_by: Number(e.target.value) })} placeholder="+12 compra, −2 perda" /></Field>
                    <Field label="Motivo"><Input value={edit.stock_reason} onChange={(e) => setEdit({ ...edit, stock_reason: e.target.value })} placeholder="compra, perda, inventário…" /></Field>
                  </div>
                  {edit.adjust_stock_by !== 0 && <p className="mt-1.5 text-[11px] text-zinc-400">Novo saldo: <b className="text-[var(--c-gold)]">{edit.stock + edit.adjust_stock_by}</b> un.</p>}
                </div>
              )}
              <div className="flex gap-4">
                <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-[var(--c-gold)]" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> À venda</label>
                <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-[var(--c-gold)]" checked={edit.featured} onChange={(e) => setEdit({ ...edit, featured: e.target.checked })} /> <Sparkle size={13} className="text-[var(--c-gold)]" /> Destaque</label>
              </div>
            </div>
            <div>
              <ImageUpload label="Foto do produto" value={edit.photo} onChange={(photo) => setEdit({ ...edit, photo })} />
              <Button className="mt-4 w-full justify-center" disabled={!edit.name || save.isPending || (edit.adjust_stock_by !== 0 && edit.stock + edit.adjust_stock_by < 0)} onClick={() => save.mutate(edit)}>{save.isPending ? "Salvando…" : "Salvar produto"}</Button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog open={Boolean(del)} onCancel={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} danger
        title={`Excluir "${del?.name}"?`} text="O produto sairá da vitrine e será desativado. Histórico de vendas e movimentações de estoque serão preservados." />
    </div>
  );
}
