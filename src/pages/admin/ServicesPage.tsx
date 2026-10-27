import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, Pencil, Plus, Tag, Trash2 } from "lucide-react";
import { clsx } from "clsx";
import { api, siteBase } from "@/lib/api";
import { Badge, Button, ConfirmDialog, EmptyState, Field, Input, Modal, Select, Spinner, Textarea, useToast } from "@/components/ui";
import { ImageUpload } from "@/components/ui/Upload";
import { money, toCents } from "@/lib/format";

type F = { id?: number; name: string; description: string; price_reais: string; duration_min: number; category: string; photo: string; active: boolean; show_in_catalog: boolean; barber_ids: number[] };
const BLANK: F = { name: "", description: "", price_reais: "", duration_min: 45, category: "cabelo", photo: "", active: true, show_in_catalog: true, barber_ids: [] };
const CATS = ["cabelo", "barba", "combo", "tratamento", "infantil", "sobrancelha", "outro"];

export function ServicesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["admin-services", siteBase()], queryFn: () => api.get<any>("/admin/services").then((d) => d.services) });
  const barbers = useQuery({ queryKey: ["admin-barbers", siteBase()], queryFn: () => api.get<any>("/admin/barbers").then((d: any) => d.barbers) });
  const [edit, setEdit] = useState<F | null>(null);
  const [del, setDel] = useState<any | null>(null);

  const save = useMutation({
    mutationFn: (f: F) => {
      const body = { name: f.name, description: f.description, price_cents: toCents(f.price_reais), duration_min: f.duration_min, category: f.category, photo: f.photo, active: f.active, show_in_catalog: f.show_in_catalog, barber_ids: f.barber_ids };
      return f.id ? api.put(`/admin/services/${f.id}`, body) : api.post("/admin/services", body);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-services"] }); qc.invalidateQueries({ queryKey: ["tenant", siteBase(), "services"] }); qc.invalidateQueries({ queryKey: ["admin-barbers"] }); setEdit(null); toast.push("ok", "Serviço salvo no catálogo."); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del<any>(`/admin/services/${id}`),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["admin-services"] }); qc.invalidateQueries({ queryKey: ["tenant", siteBase(), "services"] }); setDel(null); toast.push("ok", r?.message || "Removido."); },
    onError: (e: any) => toast.push("err", e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl text-zinc-50">Serviços & Preços</h1>
          <p className="text-xs text-zinc-500">Duração e valor alimentam direto o motor de disponibilidade do site.</p>
        </div>
        <Button size="sm" onClick={() => setEdit({ ...BLANK })}><Plus size={14} /> Novo serviço</Button>
      </div>

      {list.isLoading && <Spinner />}
      <div className="overflow-hidden rounded-2xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-ink-soft text-left text-[11px] uppercase tracking-wide text-zinc-500">
            <tr><th className="px-4 py-2.5">Serviço</th><th className="px-2 py-2.5">Categoria</th><th className="px-2 py-2.5">Duração</th><th className="px-2 py-2.5">Preço</th><th className="hidden px-2 py-2.5 md:table-cell">Atendem</th><th className="px-2 py-2.5"></th></tr>
          </thead>
          <tbody className="divide-y divide-line bg-panel">
            {(list.data ?? []).map((s: any) => (
              <tr key={s.id} className={clsx(!s.active && "opacity-50", s.active && !s.show_in_catalog && "opacity-75")}>
                <td className="px-4 py-2.5">
                  <div className="flex items-center gap-2.5">
                    {s.photo ? <img src={s.photo} alt="" className="h-9 w-12 rounded-md object-cover" /> : <span className="grid h-9 w-12 place-items-center rounded-md bg-ink-soft text-zinc-600"><Tag size={14} /></span>}
                    <div>
                      <p className="font-medium text-zinc-100">{s.name} {s.demo ? <Badge tone="gray">demo</Badge> : null}</p>
                      <p className="max-w-[280px] truncate text-[11px] text-zinc-500">{s.description}</p>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2.5"><Badge tone="gray">{s.category}</Badge></td>
                <td className="px-2 py-2.5 text-zinc-300"><Clock size={12} className="mr-1 inline text-zinc-500" />{s.duration_min} min</td>
                <td className="px-2 py-2.5 font-semibold text-[var(--c-gold)]">{money(s.price_cents)}</td>
                <td className="hidden px-2 py-2.5 text-xs text-zinc-400 md:table-cell">{(s.barber_ids ?? []).map((id: number) => barbers.data?.find((b: any) => b.id === id)?.name).filter(Boolean).join(", ") || "—"}</td>
                <td className="px-2 py-2.5 text-right">
                  <button className="rounded-lg p-1.5 text-zinc-400 hover:bg-ink-soft hover:text-[var(--c-gold)]" onClick={() => setEdit({ id: s.id, name: s.name, description: s.description, price_reais: (s.price_cents / 100).toFixed(2), duration_min: s.duration_min, category: s.category, photo: s.photo, active: !!s.active, show_in_catalog: !!s.show_in_catalog, barber_ids: s.barber_ids ?? [] })}><Pencil size={14} /></button>
                  <button className="rounded-lg p-1.5 text-zinc-400 hover:bg-ink-soft hover:text-red-400" onClick={() => setDel(s)}><Trash2 size={14} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {list.data?.length === 0 && <div className="p-4"><EmptyState icon={<Tag size={26} />} title="Catálogo vazio" text="Cadastre serviços para o site começar a receber reservas." /></div>}
      </div>

      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? "Editar serviço" : "Novo serviço"} wide>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <Field label="Nome" required><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Descrição"><Textarea value={edit.description} onChange={(e) => setEdit({ ...edit, description: e.target.value })} /></Field>
              <div className="grid grid-cols-3 gap-2">
                <Field label="Preço (R$)"><Input inputMode="decimal" value={edit.price_reais} onChange={(e) => setEdit({ ...edit, price_reais: e.target.value })} placeholder="45,00" /></Field>
                <Field label="Duração (min)"><Input type="number" min={5} max={480} step={5} value={edit.duration_min} onChange={(e) => setEdit({ ...edit, duration_min: Number(e.target.value) })} /></Field>
                <Field label="Categoria"><Select value={edit.category} onChange={(e) => setEdit({ ...edit, category: e.target.value })}>{CATS.map((c) => <option key={c}>{c}</option>)}</Select></Field>
              </div>
              <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-[var(--c-gold)]" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Ativo (recebe agendamentos)</label>
              <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-[var(--c-gold)]" checked={edit.show_in_catalog} onChange={(e) => setEdit({ ...edit, show_in_catalog: e.target.checked })} /> Visível no catálogo público</label>
              <Field label="Profissionais que atendem">
                <div className="grid grid-cols-2 gap-1 rounded-xl border border-line p-3">
                  {(barbers.data ?? []).filter((b: any) => b.active).map((b: any) => (
                    <label key={b.id} className="flex items-center gap-2 text-[13px] text-zinc-300">
                      <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--c-gold)]" checked={edit.barber_ids.includes(b.id)}
                        onChange={() => setEdit({ ...edit, barber_ids: edit.barber_ids.includes(b.id) ? edit.barber_ids.filter((x) => x !== b.id) : [...edit.barber_ids, b.id] })} />
                      {b.name}
                    </label>
                  ))}
                </div>
              </Field>
            </div>
            <div>
              <ImageUpload label="Foto do card" value={edit.photo} onChange={(photo) => setEdit({ ...edit, photo })} />
              <Button className="mt-4 w-full justify-center" disabled={!edit.name || toCents(edit.price_reais) <= 0 || save.isPending} onClick={() => save.mutate(edit)}>{save.isPending ? "Salvando…" : "Salvar serviço"}</Button>
            </div>
          </div>
        </Modal>
      )}

      <ConfirmDialog open={Boolean(del)} onCancel={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} danger
        title={`Excluir "${del?.name}"?`} text="Com histórico de reservas o serviço é desativado (some do catálogo) e o faturamento passado é preservado." />
    </div>
  );
}
