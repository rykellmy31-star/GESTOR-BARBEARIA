import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, Pencil, Plus, Star, Trash2, Users } from "lucide-react";
import { clsx } from "clsx";
import { api, siteBase } from "@/lib/api";
import { Badge, Button, ConfirmDialog, EmptyState, Field, Input, Modal, Spinner, Textarea, useToast } from "@/components/ui";
import { ImageUpload } from "@/components/ui/Upload";

const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
type BarberForm = { id?: number; name: string; specialty: string; bio: string; photo: string; work_days: number[]; work_start: string; work_end: string; break_start: string; break_end: string; active: boolean; service_ids: number[] };
const BLANK: BarberForm = { name: "", specialty: "", bio: "", photo: "", work_days: [2, 3, 4, 5, 6], work_start: "09:00", work_end: "20:00", break_start: "12:00", break_end: "13:00", active: true, service_ids: [] };

export function BarbersPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({ queryKey: ["admin-barbers", siteBase()], queryFn: () => api.get<any>("/admin/barbers").then((d) => d.barbers) });
  const services = useQuery({ queryKey: ["admin-services", siteBase()], queryFn: () => api.get<any>("/admin/services").then((d) => d.services) });
  const [edit, setEdit] = useState<BarberForm | null>(null);
  const [del, setDel] = useState<any | null>(null);
  const [cred, setCred] = useState<any | null>(null);
  const [credF, setCredF] = useState({ email: "", password: "" });

  const save = useMutation({
    mutationFn: (f: BarberForm) => (f.id ? api.put(`/admin/barbers/${f.id}`, f) : api.post("/admin/barbers", f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-barbers"] }); qc.invalidateQueries({ queryKey: ["tenant", siteBase(), "barbers"] }); qc.invalidateQueries({ queryKey: ["tenant", siteBase(), "services"] }); qc.invalidateQueries({ queryKey: ["admin-services"] }); setEdit(null); toast.push("ok", "Barbeiro salvo."); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del<any>(`/admin/barbers/${id}`),
    onSuccess: (r: any) => { qc.invalidateQueries({ queryKey: ["admin-barbers"] }); qc.invalidateQueries({ queryKey: ["tenant", siteBase(), "barbers"] }); qc.invalidateQueries({ queryKey: ["tenant", siteBase(), "services"] }); setDel(null); toast.push("ok", r?.message || "Removido."); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const creds = useMutation({
    mutationFn: (v: { id: number; email: string; password: string }) => api.post<any>(`/admin/barbers/${v.id}/credentials`, { email: v.email || undefined, password: v.password }),
    onSuccess: (r: any) => { setCred(null); toast.push("ok", `${r.message} E-mail de acesso: ${r.email}`); },
    onError: (e: any) => toast.push("err", e.message),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl text-zinc-50">Equipe</h1>
          <p className="text-xs text-zinc-500">Perfil público, expediente individual e acesso ao painel próprio.</p>
        </div>
        <Button size="sm" onClick={() => setEdit({ ...BLANK })}><Plus size={14} /> Novo barbeiro</Button>
      </div>

      {list.isLoading && <Spinner />}
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {(list.data ?? []).map((b: any) => {
          const days: number[] = Array.isArray(b.work_days) ? b.work_days : [];
          return (
            <article key={b.id} className={clsx("card-luxe rounded-2xl border border-line bg-panel p-4", !b.active && "opacity-60")}>
              <div className="flex gap-3">
                <img src={b.photo} alt="" className="h-16 w-16 rounded-xl object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-1.5 font-display text-lg text-zinc-50">
                    {b.name} {b.demo ? <Badge tone="gray">demo</Badge> : null}{!b.active ? <Badge tone="red">inativo</Badge> : null}
                  </p>
                  <p className="truncate text-xs text-[var(--c-gold)]">{b.specialty}</p>
                  <p className="mt-1 flex flex-wrap gap-1 text-[11px] text-zinc-500">
                    <Star size={11} className="fill-current text-[var(--c-gold)]" /> {Number(b.rating ?? 0).toFixed(1)} · {b.upcoming ?? 0} próximas reservas
                  </p>
                </div>
              </div>
              <p className="mt-2.5 text-[12px] leading-relaxed text-zinc-400 line-clamp-2">{b.bio}</p>
              <p className="mt-2 text-[11px] text-zinc-500">🗓 {days.map((d: number) => DAY_NAMES[d]).join(" ")} · 🕘 {b.work_start}–{b.work_end} (almoço {b.break_start}–{b.break_end})</p>
              <p className="mt-1.5 flex flex-wrap gap-1">
                {(services.data ?? []).filter((s: any) => (b.service_ids ?? []).includes(s.id)).map((s: any) => <Badge key={s.id} tone="gray">{s.name}</Badge>)}
              </p>
              <div className="mt-3 flex gap-1.5 border-t border-line pt-3">
                <Button size="sm" variant="dark" onClick={() => setEdit({ id: b.id, name: b.name, specialty: b.specialty, bio: b.bio, photo: b.photo, work_days: days, work_start: b.work_start, work_end: b.work_end, break_start: b.break_start, break_end: b.break_end, active: !!b.active, service_ids: b.service_ids ?? [] })}><Pencil size={13} /> Editar</Button>
                <Button size="sm" variant="ghost" onClick={() => { setCred(b); setCredF({ email: "", password: "" }); }}><KeyRound size={13} /> Senha do painel</Button>
                <Button size="sm" variant="danger" className="ml-auto" onClick={() => setDel(b)}><Trash2 size={13} /></Button>
              </div>
            </article>
          );
        })}
      </div>
      {list.data?.length === 0 && <EmptyState icon={<Users size={26} />} title="Nenhum barbeiro cadastrado" text="Cadastre o primeiro profissional para liberar o agendamento on-line." action={<Button size="sm" onClick={() => setEdit({ ...BLANK })}>Cadastrar agora</Button>} />}

      {edit && (
        <Modal open onClose={() => setEdit(null)} title={edit.id ? "Editar barbeiro" : "Novo barbeiro"} wide>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-3">
              <Field label="Nome" required><Input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} /></Field>
              <Field label="Especialidade"><Input value={edit.specialty} onChange={(e) => setEdit({ ...edit, specialty: e.target.value })} placeholder="ex.: degradê & barba" /></Field>
              <Field label="Bio (aparece no perfil público)"><Textarea value={edit.bio} onChange={(e) => setEdit({ ...edit, bio: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="Início"><Input type="time" step={300} value={edit.work_start} onChange={(e) => setEdit({ ...edit, work_start: e.target.value })} /></Field>
                <Field label="Fim"><Input type="time" step={300} value={edit.work_end} onChange={(e) => setEdit({ ...edit, work_end: e.target.value })} /></Field>
                <Field label="Almoço início"><Input type="time" step={300} value={edit.break_start} onChange={(e) => setEdit({ ...edit, break_start: e.target.value })} /></Field>
                <Field label="Almoço fim"><Input type="time" step={300} value={edit.break_end} onChange={(e) => setEdit({ ...edit, break_end: e.target.value })} /></Field>
              </div>
              <Field label="Dias de trabalho">
                <div className="flex flex-wrap gap-1.5">
                  {DAY_NAMES.map((d, i) => (
                    <button type="button" key={d} onClick={() => setEdit({ ...edit, work_days: edit.work_days.includes(i) ? edit.work_days.filter((x) => x !== i) : [...edit.work_days, i].sort() })}
                      className={clsx("rounded-lg border px-3 py-1.5 text-xs font-semibold", edit.work_days.includes(i) ? "border-[var(--c-gold)] bg-gold-soft text-[var(--c-gold)]" : "border-line text-zinc-400")}>{d}</button>
                  ))}
                </div>
              </Field>
            </div>
            <div className="space-y-3">
              <ImageUpload label="Foto de perfil" value={edit.photo} onChange={(photo) => setEdit({ ...edit, photo })} aspect="aspect-[4/5]" />
              <Field label="Serviços que atende">
                <div className="space-y-1 rounded-xl border border-line p-3">
                  {(services.data ?? []).map((s: any) => (
                    <label key={s.id} className="flex items-center gap-2 text-[13px] text-zinc-300">
                      <input type="checkbox" className="h-3.5 w-3.5 accent-[var(--c-gold)]" checked={edit.service_ids.includes(s.id)}
                        onChange={() => setEdit({ ...edit, service_ids: edit.service_ids.includes(s.id) ? edit.service_ids.filter((x) => x !== s.id) : [...edit.service_ids, s.id] })} />
                      {s.name} <span className="ml-auto text-zinc-500">{s.duration_min} min</span>
                    </label>
                  ))}
                </div>
              </Field>
              <label className="flex items-center gap-2 text-sm text-zinc-300"><input type="checkbox" className="h-4 w-4 accent-[var(--c-gold)]" checked={edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Aparece no site e recebe agendamentos</label>
              <Button className="w-full justify-center" disabled={!edit.name || edit.work_days.length === 0 || save.isPending} onClick={() => save.mutate(edit)}>
                {save.isPending ? "Salvando…" : "Salvar barbeiro"}
              </Button>
            </div>
          </div>
        </Modal>
      )}

      {cred && (
        <Modal open onClose={() => setCred(null)} title={`Acesso ao painel — ${cred.name}`}>
          <p className="mb-3 text-xs leading-relaxed text-zinc-500">Define/renova o usuário <b className="text-zinc-300">barber</b> vinculado a este profissional. Ele entra em <code className="text-[var(--c-gold)]">/admin</code> com este e-mail e vai direto para o painel individual (agenda própria, concluir atendimentos, pedir bloqueios).</p>
          <div className="space-y-3">
            <Field label="E-mail de acesso" hint="em branco = gerado do slug"><Input type="email" value={credF.email} onChange={(e) => setCredF({ ...credF, email: e.target.value })} placeholder={`${cred.slug}@painel.barbearia.local`} /></Field>
            <Field label="Senha temporária" required hint="mín. 10 caracteres — oriente a trocar depois"><Input value={credF.password} onChange={(e) => setCredF({ ...credF, password: e.target.value })} placeholder="ex.: Navalha#DeOuro1" /></Field>
            <Button className="w-full justify-center" disabled={credF.password.length < 10 || creds.isPending} onClick={() => creds.mutate({ id: cred.id, ...credF })}>{creds.isPending ? "Definindo…" : "Definir credenciais"}</Button>
          </div>
        </Modal>
      )}

      <ConfirmDialog open={Boolean(del)} onCancel={() => setDel(null)} onConfirm={() => del && remove.mutate(del.id)} danger
        title={`Remover ${del?.name}?`} text="Se houver histórico, o sistema desativa o profissional e preserva os registros (integridade > limpeza). Confirme para continuar." />
    </div>
  );
}
