import { useState } from "react";
import { KeyRound, Loader2, Search, ShieldCheck, Trash2, UserX } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Field, Input, Modal, Select, Spinner, useToast } from "@/components/ui";
import { H, Table, Td, Tr } from "./shared";

export function SuperUsers() {
  const qc = useQueryClient();
  const toast = useToast();
  const [q0, setQ0] = useState("");
  const [sel, setSel] = useState<any | null>(null);
  const [pw, setPw] = useState("");
  const [just, setJust] = useState("");
  const list = useQuery({ queryKey: ["super-users", q0], queryFn: () => api.get<any>(`/super/users?q=${encodeURIComponent(q0)}`).then((d) => d.users as any[]) });
  const upd = useMutation({
    mutationFn: (body: any) => api.put(`/super/users/${sel.id}`, body),
    onSuccess: () => { toast.push("ok", "Usuário atualizado."); qc.invalidateQueries({ queryKey: ["super-users"] }); setSel(null); setPw(""); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const erase = useMutation({
    mutationFn: () => api.post(`/super/users/${sel.id}/erase`, { justification: just }),
    onSuccess: () => { toast.push("ok", "Conta anonimizada (LGPD) — registros de agendamento preservam só o necessário."); qc.invalidateQueries({ queryKey: ["super-users"] }); setSel(null); setJust(""); },
    onError: (e: any) => toast.push("err", e.message),
  });

  return (
    <div>
      <H title="Usuários" sub="Contas globais Tigu: um login pode pertencer a várias barbearias." />
      <div className="relative mb-4 max-w-sm"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" /><Input placeholder="nome ou e-mail…" value={q0} onChange={(e) => setQ0(e.target.value)} className="pl-9" /></div>
      {list.isLoading ? <Spinner /> : (
        <Table head={["Nome", "E-mail", "Papel", "Barbearias", "Último acesso", ""]}>
          {(list.data ?? []).map((u: any) => (
            <Tr key={u.id} onClick={() => setSel(u)}>
              <Td className="font-medium text-zinc-100">{u.name} {u.must_change_password === 1 && <Badge tone="amber">troca senha</Badge>}</Td>
              <Td className="text-zinc-400">{u.email}</Td>
              <Td><Badge tone={u.platform_role === "superadmin" ? "blue" : "gray"}>{u.platform_role}</Badge></Td>
              <Td className="max-w-[220px] truncate text-xs text-zinc-500">{u.companies || "—"}</Td>
              <Td className="text-xs">{u.last_login_at ? new Date(u.last_login_at).toLocaleString("pt-BR", { hour12: false }) : "nunca"}</Td>
              <Td className="text-right">{u.active === 0 && <span className="text-[10px] uppercase text-red-300">inativo</span>}</Td>
            </Tr>
          ))}
        </Table>
      )}
      <Modal open={!!sel} onClose={() => setSel(null)} title={sel ? sel.name : ""}>
        {sel && (
          <div className="space-y-3">
            <Field label="Papel na plataforma"><Select value={sel.platform_role} onChange={(e) => upd.mutate({ platform_role: e.target.value })}><option value="user">usuário</option><option value="superadmin">superadmin (equipe Tigu)</option></Select></Field>
            <div className="flex gap-2">
              <Button className="flex-1 justify-center border border-line py-2 text-sm" onClick={() => upd.mutate({ active: sel.active === 0 })}>{sel.active === 0 ? <>Reativar conta</> : <><UserX size={14} /> Desativar conta</>}</Button>
            </div>
            <Field label="Resetar senha (10+ chars)" hint="Gera troca obrigatória no próximo login e derruba sessões."><div className="flex gap-2"><Input type="password" value={pw} onChange={(e) => setPw(e.target.value)} className="flex-1" /><Button className="btn-gold px-3 py-2" disabled={pw.length < 10 || upd.isPending} onClick={() => upd.mutate({ reset_password: pw })}>{upd.isPending ? <Loader2 size={14} className="animate-spin" /> : <KeyRound size={14} />}</Button></div></Field>
            <div className="rounded-xl border border-red-500/30 bg-red-500/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-red-200"><Trash2 size={13} /> Direito ao esquecimento (LGPD)</p>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-400">Remove PII da conta, desliga memberships e sessões; lançamentos financeiros permanecem como exigem obrigações contábeis.</p>
              <div className="mt-2 flex gap-2"><Input placeholder="Justificativa (10+)" value={just} onChange={(e) => setJust(e.target.value)} className="flex-1" /><Button className="rounded-xl bg-red-500/80 px-3 py-2 text-sm" disabled={just.length < 10 || erase.isPending} onClick={() => { if (confirm(`Anonimizar ${sel.email}? Ação irreversível.`)) erase.mutate(); }}>Apagar</Button></div>
            </div>
            <p className="flex items-center gap-1 text-[10px] text-zinc-600"><ShieldCheck size={11} /> toda ação desta suíte cai no audit_log com escopo platform</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
