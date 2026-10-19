import { useState } from "react";
import { Loader2, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, EmptyState, Field, Input, Modal, Select, useToast } from "@/components/ui";

export function TeamPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["team"], queryFn: () => api.get<any>("/admin/team").then((d) => d.team as any[]) });
  const barbers = useQuery({ queryKey: ["admin-barbers"], queryFn: () => api.get<any>("/admin/barbers").then((d) => d.barbers as any[]) });
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", email: "", role: "barber", barber_id: "", password: "" });
  const add = useMutation({
    mutationFn: () => api.post("/admin/team", { ...f, barber_id: f.barber_id ? Number(f.barber_id) : null }),
    onSuccess: (r: any) => {
      toast.push("ok", r.created ? "Conta criada para o integrante." : "Acesso vinculado à conta existente.");
      qc.invalidateQueries({ queryKey: ["team"] }); setOpen(false);
    },
    onError: (e: any) => toast.push("err", e.message),
  });
  const revoke = useMutation({
    mutationFn: (id: number) => api.put(`/admin/team/${id}`, { active: false }),
    onSuccess: () => { toast.push("ok", "Acesso removido."); qc.invalidateQueries({ queryKey: ["team"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const valid = f.name.trim().length >= 2 && /\S+@\S+\.\w+/.test(f.email) && (f.role !== "barber" || f.barber_id !== "") && f.password.length >= 10;

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl text-zinc-50">Equipe & acessos</h1>
          <p className="mt-1 text-xs text-zinc-500">Quem pode entrar nos painéis desta barbearia (papéis valem no servidor, não só na tela).</p>
        </div>
        <Button className="btn-gold" onClick={() => setOpen(true)}><Plus size={15} /> Adicionar integrante</Button>
      </div>
      <div className="overflow-x-auto rounded-2xl border border-line bg-panel">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-line text-left text-[11px] uppercase tracking-wide text-zinc-500">
            <th className="px-4 py-3">Nome</th><th className="px-4 py-3">E-mail</th><th className="px-4 py-3">Papel</th><th className="px-4 py-3">Último acesso</th><th className="px-4 py-3"></th>
          </tr></thead>
          <tbody>
            {(q.data ?? []).map((m) => (
              <tr key={m.membership_id} className="border-b border-line/60 last:border-0">
                <td className="px-4 py-3 text-zinc-100">{m.name}{m.barber_name ? <span className="ml-2 text-xs text-zinc-500">↳ {m.barber_name}</span> : null}</td>
                <td className="px-4 py-3 text-zinc-400">{m.email}</td>
                <td className="px-4 py-3"><Badge tone={m.role === "owner" ? "gold" : "gray"}>{m.role}</Badge></td>
                <td className="px-4 py-3 text-xs text-zinc-500">{m.last_login_at ? new Date(m.last_login_at).toLocaleDateString("pt-BR") : "nunca"}</td>
                <td className="px-4 py-3 text-right">
                  {m.role !== "owner" && m.active === 1 && (
                    <button className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-xs text-zinc-400 hover:border-red-500/60 hover:text-red-300" onClick={() => { if (confirm(`Remover acesso de ${m.name}?`)) revoke.mutate(m.membership_id); }}>
                      <Trash2 size={13} /> remover
                    </button>
                  )}
                  {m.active === 0 && <span className="text-xs text-zinc-600">inativo</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!q.isLoading && !(q.data ?? []).length && <EmptyState icon={<ShieldCheck size={28} />} title="Só você por aqui" text="Adicione gerentes e crie o acesso dos profissionais ao painel." />}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="Adicionar integrante">
        <div className="space-y-4">
          <Field label="Nome"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="E-mail (login)"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Papel"><Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}><option value="barber">Profissional (painel)</option><option value="manager">Gerente (painel completo)</option></Select></Field>
            {f.role === "barber" && (
              <Field label="Vincular a"><Select value={f.barber_id} onChange={(e) => setF({ ...f, barber_id: e.target.value })}><option value="">selecione…</option>{(barbers.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
            )}
          </div>
          <Field label="Senha provisória (10+)" hint="O integrante troca no primeiro acesso. Se o e-mail já tiver conta Tigu, a senha não é usada."><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          <Button className="btn-gold w-full justify-center py-2.5" disabled={!valid || add.isPending} onClick={() => add.mutate()}>
            {add.isPending ? <Loader2 size={15} className="animate-spin" /> : null} Convidar / criar acesso
          </Button>
        </div>
      </Modal>
    </div>
  );
}
