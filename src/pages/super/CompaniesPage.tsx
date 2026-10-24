import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Copy, Loader2, Plus, Search, Trash2 } from "lucide-react";
import { buildOwnerWelcomeMessage, formatTrialEnd, type OwnerWelcomeDetails } from "@/lib/owner-welcome";
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
  const [access,setAccess]=useState<OwnerWelcomeDetails|null>(null);
  const [f, setF] = useState({ name: "", slug: "", plan_code: "pro", owner_name: "", owner_email: "", owner_password: "" });
  const list = useQuery({ queryKey: ["super-companies", q], queryFn: () => api.get<any>(`/super/companies?q=${encodeURIComponent(q)}`).then((d) => d.companies as any[]) });
  const create = useMutation({
    mutationFn: () => api.post<any>("/super/companies", { ...f, owner_password: f.owner_password || undefined, slug: f.slug || undefined }),
    gcTime: 0,
    onSuccess: (r) => {
      setAccess({
        companyName:r.company_name ?? f.name.trim(),ownerName:r.owner_name ?? f.owner_name.trim(),
        ownerEmail:f.owner_email,slug:r.slug,planCode:r.plan_code ?? f.plan_code,
        trialEnd:r.trial_end,trialDays:r.trial_days ?? 15,
        // Somente na memória desta janela. Nunca persistir a senha em claro.
        initialPassword:r.created_user ? (r.generated_password ?? f.owner_password) : undefined,
        createdUser:r.created_user === true,origin:location.origin,
      });
      toast.push("ok", "Barbearia criada com teste gratuito de 15 dias.");
      qc.invalidateQueries({queryKey:["super-companies"]});
      setOpen(false);
      setF({name:"",slug:"",plan_code:"pro",owner_name:"",owner_email:"",owner_password:""});
    },
    onError: (e: any) => toast.push("err", e.message),
  });
  const seed = useMutation({
    mutationFn: (id: number) => api.post<any>(`/super/companies/${id}/seed-demo`, {}),
    onSuccess: () => { toast.push("ok", "Dados de demonstração semeados (demo=1, apagáveis)."); qc.invalidateQueries({ queryKey: ["super-companies"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const removeDemo = useMutation({
    mutationFn: (id: number) => api.del(`/super/companies/${id}/demo`),
    onSuccess: () => { toast.push("ok","Barbearia fictícia excluída."); qc.invalidateQueries({queryKey:["super-companies"]}); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const valid = f.name.trim().length >= 3 && f.owner_name.trim().length >= 2 && /\S+@\S+\.\w+/.test(f.owner_email) && (!f.slug || /^[a-z0-9-]{3,80}$/.test(f.slug)) && (!f.owner_password || f.owner_password.length >= 10);

  return (
    <div>
      <H title="Barbearias" sub="Cadastrar cliente, ajustar plano, semear demonstração — tudo auditado." action={<Button className="btn-gold" onClick={() => setOpen(true)}><Plus size={15} /> Nova barbearia</Button>} />
      <div className="relative mb-4 max-w-sm"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" /><Input placeholder="nome ou slug…" value={q} onChange={(e) => setQ(e.target.value)} className="pl-9" /></div>
      {list.isLoading ? <Spinner /> : list.isError ? (
        <div role="alert" className="rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">
          Não foi possível carregar as barbearias.
          <button className="ml-2 underline" onClick={() => void list.refetch()}>Tentar novamente</button>
        </div>
      ) : (
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
              <Td className="text-right"><div className="flex items-center justify-end gap-3">
                {(c.demo === 1 || (/^Tigu (Teste|Isolamento) [a-f0-9]{8}$/i.test(c.name))) &&
                  <button title="Excluir apenas barbearia fictícia" disabled={removeDemo.isPending}
                    className="inline-flex items-center gap-1 text-xs text-red-300 hover:underline disabled:opacity-40"
                    onClick={(e) => {e.stopPropagation(); if(confirm(`Excluir definitivamente a barbearia fictícia "${c.name}"? Operação irreversível, permitida apenas sem movimentação financeira.`)) removeDemo.mutate(c.id);}}>
                    <Trash2 size={13}/> Excluir
                  </button>}
                <button disabled={seed.isPending} className="text-xs text-[var(--c-gold)] hover:underline disabled:opacity-40" onClick={(e) => { e.stopPropagation(); if (confirm(`Semear dados de demonstração em ${c.name}?`)) seed.mutate(c.id); }}>{seed.isPending ? "…" : "seed demo"}</button></div></Td>
            </Tr>
          ))}
        </Table>
      )}
      <Modal open={Boolean(access)} onClose={()=>{setAccess(null);create.reset();}} title="Barbearia criada — mensagem para o proprietário">
        {access && <div className="min-w-0 space-y-3 text-sm text-zinc-300">
          <p className="text-zinc-200">Cadastro realizado. Confira os dados e copie a mensagem para o dono da barbearia.</p>
          <div className="grid gap-2 rounded-xl border border-line bg-ink-soft p-3 sm:grid-cols-2">
            <p className="break-words"><span className="text-zinc-500">Barbearia:</span> {access.companyName}</p>
            <p className="break-words"><span className="text-zinc-500">Proprietário:</span> {access.ownerName}</p>
            <p className="break-all"><span className="text-zinc-500">Login:</span> {access.ownerEmail}</p>
            <p><span className="text-zinc-500">Plano:</span> {access.planCode.toUpperCase()}</p>
            <p><span className="text-zinc-500">Teste:</span> {access.trialDays} dias grátis</p>
            <p><span className="text-zinc-500">Válido até:</span> {formatTrialEnd(access.trialEnd)}</p>
          </div>
          <p className="text-xs text-amber-200">O plano está selecionado, mas não foi pago. A data acima é do teste gratuito.</p>
          <label htmlFor="tigu-welcome-message" className="block text-sm font-semibold text-zinc-200">Mensagem pronta para copiar e enviar</label>
          <textarea id="tigu-welcome-message" readOnly aria-label="Mensagem de acesso para o proprietário"
            className="min-h-64 w-full max-w-full resize-y rounded-xl border border-line bg-[#0a0a0c] p-3 font-mono text-xs leading-relaxed text-zinc-100"
            value={buildOwnerWelcomeMessage(access)} onFocus={(e) => e.target.select()} />
          <Button className="btn-gold w-full justify-center py-3" onClick={async () => {
            try {
              await navigator.clipboard.writeText(buildOwnerWelcomeMessage(access));
              toast.push("ok", "Mensagem copiada! Envie diretamente ao proprietário.");
            } catch {
              const textarea = document.getElementById("tigu-welcome-message") as HTMLTextAreaElement | null;
              textarea?.focus(); textarea?.select();
              toast.push("err", "Selecione a mensagem e use Copiar no dispositivo.");
            }
          }}><Copy size={16} /> Copiar mensagem completa</Button>
          <p className="text-xs leading-relaxed text-zinc-500">
            {access.createdUser
              ? "A senha provisória aparece apenas nesta mensagem. No primeiro login, o usuário será obrigado a alterá-la. Depois de fechar, não é possível recuperar a senha em texto aberto."
              : "Este e-mail já tinha uma conta TIGU. A senha antiga não foi redefinida e não pode ser exibida."}
          </p>
          <Button variant="dark" className="w-full justify-center" onClick={()=>{setAccess(null);create.reset();}}>Concluir e apagar a prévia</Button>
        </div>}
      </Modal>
      <Modal open={open} onClose={() => setOpen(false)} title="Cadastrar barbearia (onboarding assistido)">
        <div className="space-y-3">
          <p className="text-xs text-zinc-500">O cadastro inicia um teste gratuito de 15 dias. Não gera cobrança nem confirma pagamento.</p>
          <Field label="Nome"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
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
