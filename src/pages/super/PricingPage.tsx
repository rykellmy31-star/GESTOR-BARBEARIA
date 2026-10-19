import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Field, Input, Select, Spinner, useToast } from "@/components/ui";
import { money } from "@/lib/format";
import { H, Money, Table, Td, Tr } from "./shared";

export function SuperPricing() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ["super-pricing"], queryFn: () => api.get<any>("/super/pricing") });
  const [f, setF] = useState({ company_id: "", category: "any", price_cents: "10", cost_cents: "5" });
  const cos = useQuery({ queryKey: ["super-companies-all"], queryFn: () => api.get<any>("/super/companies").then((d) => d.companies as any[]) });
  const set = useMutation({
    mutationFn: () => api.post<any>("/super/pricing", { company_id: f.company_id ? Number(f.company_id) : null, category: f.category, price_cents: Number(f.price_cents), cost_cents: Number(f.cost_cents) }),
    onSuccess: (r) => { toast.push("ok", r.message); qc.invalidateQueries({ queryKey: ["super-pricing"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const off = useMutation({ mutationFn: (id: number) => api.del(`/super/pricing/${id}`), onSuccess: () => qc.invalidateQueries({ queryKey: ["super-pricing"] }) });
  if (q.isLoading) return <Spinner />;

  return (
    <div>
      <H title="Precificação de mensagens" sub="Padrão global + exceções por barbearia. Regras valem para novos agendamentos; jobs já programados mantêm preço congelado." />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.5fr]">
        <div className="card-luxe h-fit rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
          <h2 className="font-display text-base text-zinc-100">Nova regra</h2>
          <div className="mt-3 space-y-3">
            <Field label="Empresa"><Select value={f.company_id} onChange={(e) => setF({ ...f, company_id: e.target.value })}><option value="">padrão global</option>{(cos.data ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
            <div className="grid grid-cols-3 gap-2">
              <Field label="Categoria"><Select value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}><option value="any">any</option><option value="utility">utility</option><option value="marketing">marketing</option><option value="authentication">auth</option></Select></Field>
              <Field label="Preço (¢)"><Input type="number" value={f.price_cents} onChange={(e) => setF({ ...f, price_cents: e.target.value })} /></Field>
              <Field label="Custo (¢)"><Input type="number" value={f.cost_cents} onChange={(e) => setF({ ...f, cost_cents: e.target.value })} /></Field>
            </div>
            <p className="text-[11px] text-zinc-500">Margem: {money(Math.max(0, Number(f.price_cents) - Number(f.cost_cents)))} por mensagem.</p>
            <Button className="btn-gold w-full justify-center py-2.5 text-sm" disabled={!Number(f.price_cents) || set.isPending} onClick={() => set.mutate()}><Plus size={14} /> Aplicar regra</Button>
          </div>
        </div>
        <div>
          <Table head={["Escopo", "Categoria", "Preço", "Custo", "Margem", ""]}>
            {(q.data.rules ?? []).map((r: any) => (
              <Tr key={r.id}>
                <Td className={r.company_id ? "" : "font-semibold text-zinc-100"}>{r.company_name}</Td>
                <Td><Badge tone="gray">{r.category}</Badge></Td>
                <Td><Money cents={r.price_cents} /></Td><Td><Money cents={r.cost_cents} /></Td>
                <Td className="text-emerald-300"><Money cents={r.price_cents - r.cost_cents} /></Td>
                <Td className="text-right"><button className="text-zinc-500 hover:text-red-300" onClick={() => off.mutate(r.id)} title="desativar regra"><Trash2 size={13} /></button></Td>
              </Tr>
            ))}
          </Table>
          <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">Defaults de plataforma (recarga mín/má, alerta de saldo, tentativas): <b>{money(q.data.platform?.topup_min_cents ?? 1000)}</b>–<b>{money(q.data.platform?.topup_max_cents ?? 500000)}</b> por Pix, {q.data.platform?.msg_max_attempts ?? 3} tentativas com backoff de {q.data.platform?.retry_backoff_sec ?? 120}s. Ajuste em Config. da plataforma.</p>
        </div>
      </div>
    </div>
  );
}
