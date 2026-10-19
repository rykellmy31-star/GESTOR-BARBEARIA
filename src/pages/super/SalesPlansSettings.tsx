import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Save } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui";
import { money } from "@/lib/format";

type Code = "free" | "pro" | "scale";
type Plan = { code: Code; name: string; price_cents_month: number; max_barbers: number;
  max_messages_month: number; whatsapp_enabled: number; store_enabled: number; };
type PlanDraft = Omit<Plan, "code" | "whatsapp_enabled" | "store_enabled"> &
  { whatsapp_enabled: boolean; store_enabled: boolean; };
const toDraft = (p: Plan): PlanDraft => ({
  name: p.name, price_cents_month: p.price_cents_month, max_barbers: p.max_barbers,
  max_messages_month: p.max_messages_month,
  whatsapp_enabled: p.whatsapp_enabled === 1, store_enabled: p.store_enabled === 1
});

function EditablePlan({ plan, saved }: { plan: Plan; saved: () => void }) {
  const toast = useToast();
  const [draft, setDraft] = useState<PlanDraft>(() => toDraft(plan));
  const save = useMutation({
    mutationFn: () => api.put("/super/plans/" + plan.code, draft),
    onSuccess: () => { toast.push("ok", "Plano salvo. A vitrine já pode ler os novos valores pelo backend."); saved(); },
    onError: (e: Error) => toast.push("err", e.message),
  });
  const update = <K extends keyof PlanDraft>(key: K, value: PlanDraft[K]) =>
    setDraft(p => ({ ...p, [key]: value }));
  return (
    <form onSubmit={e => { e.preventDefault(); save.mutate(); }}
      className="rounded-2xl border border-[#35313b] bg-[#16161c] p-4 sm:p-5">
      <div className="mb-4 flex items-center justify-between gap-2">
        <h3 className="font-display text-lg text-zinc-100">{plan.code === "free" ? "Start" : plan.code === "pro" ? "Pro" : "Scale"}</h3>
        <span className="text-sm font-semibold text-[#d4af37]">{money(draft.price_cents_month)}/mês</span>
      </div>
      <div className="space-y-3">
        <label className="block text-xs text-zinc-300">Nome mostrado na vitrine
          <input className="input-dark mt-1.5 w-full" maxLength={60} minLength={4} required value={draft.name} onChange={e=>update("name",e.target.value)} />
        </label>
        <label className="block text-xs text-zinc-300">Mensalidade (em centavos)
          <input className="input-dark mt-1.5 w-full" type="number" min={0} max={1000000} required disabled={plan.code==="free"}
            value={draft.price_cents_month} onChange={e=>update("price_cents_month",Number(e.target.value))} />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="block text-xs text-zinc-300">Máx. profissionais
            <input className="input-dark mt-1.5 w-full" type="number" min={-1} max={500} required
              value={draft.max_barbers} onChange={e=>update("max_barbers",Number(e.target.value))} />
          </label>
          <label className="block text-xs text-zinc-300">Limite de mensagens/mês
            <input className="input-dark mt-1.5 w-full" type="number" min={-1} max={1000000} required
              value={draft.max_messages_month} onChange={e=>update("max_messages_month",Number(e.target.value))} />
          </label>
        </div>
        <p className="text-[11px] text-zinc-500">Use -1 para ilimitado. Alterar limites pode afetar barbearias já nesse plano.</p>
        <label className="flex items-center gap-2 text-xs text-zinc-300"><input type="checkbox" checked={draft.whatsapp_enabled}
          onChange={e=>update("whatsapp_enabled",e.target.checked)} className="accent-[#d4af37]" /> Habilitar WhatsApp</label>
        <label className="flex items-center gap-2 text-xs text-zinc-300"><input type="checkbox" checked={draft.store_enabled}
          onChange={e=>update("store_enabled",e.target.checked)} className="accent-[#d4af37]" /> Habilitar loja</label>
      </div>
      <button type="submit" disabled={save.isPending || (plan.code==="free" && draft.price_cents_month!==0)}
        className="btn-gold mt-4 inline-flex w-full items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
        <Save size={14} /> {save.isPending ? "Salvando…" : "Salvar plano"}
      </button>
    </form>
  );
}

export function SalesPlansSettings() {
  const qc = useQueryClient();
  const q = useQuery({queryKey:["super-sales-plans"],queryFn:()=>api.get<{plans:Plan[]}>("/super/plans")});
  return (
    <section className="mb-8" aria-label="Planos comerciais de contratação">
      <div className="mb-4">
        <h2 className="font-display text-xl text-zinc-100">Planos e valores da página de vendas</h2>
        <p className="mt-2 max-w-3xl text-xs leading-relaxed text-zinc-400">
          Configure preços e limites dos planos. O site funcional lê os valores do banco D1.
          Isso <strong>não cobra mensalidades automaticamente</strong>: ativação e pagamento recorrente continuam pendentes de integração.
        </p>
      </div>
      {q.isLoading ? <p className="text-sm text-zinc-400">Carregando planos…</p> :
        q.isError ? <p role="alert" className="text-sm text-amber-300">Não foi possível carregar os planos. Verifique o Worker e D1.</p> :
        <div className="grid gap-3 md:grid-cols-3">
          {(q.data?.plans ?? []).map(p=><EditablePlan key={p.code} plan={p}
            saved={()=>void qc.invalidateQueries({queryKey:["super-sales-plans"]})}/>)}
        </div>}
      <p className="mt-4 flex items-start gap-2 text-xs text-zinc-500">
        <CheckCircle2 size={14} className="shrink-0 text-[#d4af37]" />
        Os valores do site serão os cadastrados aqui. Na prévia estática, sem D1, eles serão identificados como ilustrativos.
      </p>
    </section>
  );
}
