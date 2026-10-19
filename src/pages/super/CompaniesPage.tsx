import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Loader2, Plus, Search } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Field, Input, Modal, Select, Spinner, useToast } from "@/components/ui";
import { H, Money, Table, Td, Tr } from "./shared";

export function SuperCompanies() {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", slug: "", plan_code: "pro", owner_name: "", owner_email: "", owner_password: "" });
  const list = useQuery({ queryKey: ["super-companies", q], queryFn: () => api.get<any>(`/super/companies?q=${encodeURIComponent(q)}`).then((d) => d.companies as any[]) });
  const create = useMutation({
    mutationFn: () => api.post<any>("/super/companies", { ...f, owner_password: f.owner_password || undefined, slug: f.slug || undefined }),
    onSuccess: (r) => { toast.push("ok", `Barbearia criada em /c/${r.slug}${r.created_user ? " (dono criado)" : ""}.`); qc.invalidateQueries({ queryKey: ["super-companies"] }); setOpen(false); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const seed = useMutation({
    mutationFn: (id: number) => api.post<any>(`/super/companies/${id}/seed-demo`, {}),
    onSuccess: () => { toast.push("ok", "Dados de demonstração semeados (demo=1, apagáveis)."); qc.invalidateQueries({ queryKey: ["super-companies"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const valid = f.name.trim().length >= 3 && f.owner_name.trim().length >= 2 && /\S+@\S+\.\w+/.test(f.owner_email) && (!f.slug || /^[a-z0-9-]{3,80}$/.test(f.slug)) && (!f.owner_password || f.owner_password.length >= 10);

  return (
    <div>
      <H title="Barbearias" sub="Cadastrar cliente, ajustar plano, semear demonstração — tudo auditado." action={<Button className="btn-gold" onClick={() => setOpen(true)}><Plus size={15} /> Nova barbearia</Button>} />
      <div className="relative mb-4 max-w-sm"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" /><Input placeholder="nome ou slug…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" /></div>
      {list.isLoading ? <Spinner /> : (
        <Table head={["Empresa", "Slug", "Plano", "Status", "Saldo", "Msgs mês", "Reservas", "Membros"]}>
          {(list.data ?? []).map((c: any) => (
            <Tr key={c.id} onClick={() => navigate(`${c.id}`)}>
              <Td className="font-medium text-zinc-100">{c.name} {c.demo === 1 && <Badge tone="blue">demo</Badge>}</Td>
              <Td><a className="font-mono text-xs text-zinc-400 hover:text-[var(--c-gold)]" onClick={(e) => e.stopPropagation()} href={`/c/${c.slug}`} target="_blank">{c.slug}</a></Td>
              <Td>{c.plan_code}</Td>
              <Td><Badge tone={c.status === "active" ? "green" : "red"}>{c.status}</Badge></Td>
              <Td><Money cents={c.balance_cents} /></Td>
              <Td>{c.msgs_this_month}{c.upcoming > 0 && <span className="ml-1.5 text-[10px] text-zinc-500">{c.upcoming} reservas</span>}</Td>
              <Td>{c.members}</Td>
              <Td className="text-right"><button className="text-xs text-[var(--c-gold)] hover:underline" onClick={(e) => { e.stopPropagation(); if (confirm(`Semear dados de demonstração em ${c.name}?`)) seed.mutate(c.id); }}>{seed.isPending ? "…" : "seed demo"}</button></Td>
            </Tr>
          ))}
        </Table>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title="Cadastrar barbearia (onboarding assistido)">
        <div className="space-y-3">
          <Field label="Nome"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Slug do link (opcional)"><Input value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-") })} placeholder="navalha-de-ouro" /></Field>
            <Field label="Plano"><Select value={f.plan_code} onChange={(e) => setF({ ...f, plan_code: e.target.value })}><option value="free">free</option><option value="pro">pro</option><option value="scale">scale</option></Select></Field>
          </div>
          <Field label="E-mail do dono"><Input type="email" value={f.owner_email} onChange={(e) => setF({ ...f, owner_email: e.target.value })} /></Field>
          <Field label="Nome do dono"><Input value={f.owner_name} onChange={(e) => setF({ ...f, owner_name: e.target.value })} /></Field>
          <Field label="Senha inicial (opcional)" hint="Vazio = geramos uma e marcamos troca obrigatória no 1º login."><Input type="password" value={f.owner_password} onChange={(e) => setF({ ...f, owner_password: e.target.value })} /></Field>
          <Button className="btn-gold w-full justify-center py-2.5" disabled={!valid || create.isPending} onClick={() => create.mutate()}>{create.isPending && <Loader2 size={14} className="mr-1 animate-spin" />}Criar</Button>
        </div>
      </Modal>
    </div>
  );
}
