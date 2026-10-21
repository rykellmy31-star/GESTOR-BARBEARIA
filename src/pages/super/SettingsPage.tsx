import { useState } from "react";
import { Loader2, Save } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Button, Field, Input, Select, Spinner, useToast } from "@/components/ui";
import { money } from "@/lib/format";
import { H } from "./shared";
import { SalesContactSettings } from "./SalesContactSettings";
import { SalesPlansSettings } from "./SalesPlansSettings";

const LABELS: Record<string, { label: string; hint?: string; kind: "cents" | "int" | "enum" }> = {
  msg_price_cents: { label: "Preço padrão por mensagem", hint: "Enquanto não houver regra própria de precificação; recomendado R$ 0,10 para começar.", kind: "cents" },
  msg_cost_cents: { label: "Custo estimado do provedor", hint: "Usado só para mostrar margem; o custo real vem do Meta Billing no reconciliar.", kind: "cents" },
  capture_on: { label: "Momento da cobrança", hint: "'sent' cobra quando o provedor aceita (padrão Tigu: justo e mais simples). 'delivered' espera confirmação de entrega — mais rígido, pode não chegar nunca se o cliente estiver off-line.", kind: "enum" },
  msg_max_attempts: { label: "Tentativas por envio", kind: "int", hint: "Depois disso o job vira 'failed' e o valor reservado é liberado automaticamente." },
  retry_backoff_sec: { label: "Backoff entre tentativas (s)", kind: "int" },
  topup_min_cents: { label: "Recarga mínima", kind: "cents" },
  topup_max_cents: { label: "Recarga máxima", kind: "cents" },
  low_balance_alert_cents: { label: "Alerta de saldo baixo", kind: "cents", hint: "Abaixo disso a barbearia recebe notificação no painel." },
  reminder_lead_min: { label: "Lembrete padrão (min antes)", kind: "int", hint: "Sobrescritível por barbearia em Configurações." },
};

export function SuperSettings() {
  const qc = useQueryClient(); const toast = useToast();
  const q = useQuery({ queryKey: ["super-settings"], queryFn: () => api.get<any>("/super/settings") });
  const [draft, setDraft] = useState<Record<string, number | string>>({});
  const save = useMutation({
    mutationFn: ({ key, value }: { key: string; value: number | string }) => api.put("/super/settings", { key, value }),
    onSuccess: () => { toast.push("ok", "Configuração aplicada (cache de 60s)."); qc.invalidateQueries({ queryKey: ["super-settings"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  if (q.isLoading) return <Spinner />;
  if (q.isError || !q.data) return <div role="alert" className="rounded-xl border border-amber-500/40 bg-[#16161c] p-5 text-sm text-amber-200">Não foi possível carregar as configurações financeiras. Nenhuma alteração foi enviada. <button className="underline" onClick={() => void q.refetch()}>Tentar novamente</button></div>;
  const s = { ...q.data.settings, ...draft };
  return (
    <div>
      <H title="Configuração da plataforma" sub="Defaults que valem para todas as barbearias, cada mudança isolada e auditada." />
      <SalesContactSettings />
      <SalesPlansSettings />
      <div className="grid max-w-2xl gap-3">
        {Object.keys(LABELS).map((k) => {
          const meta = LABELS[k];
          return (
            <div key={k} className="flex items-end gap-3 rounded-2xl border border-[#26262f] bg-[#16161c] p-4">
              <div className="flex-1">
                <Field label={meta.label} hint={meta.hint}>
                  {meta.kind === "enum" ? (
                    <Select value={String(s[k] ?? "sent")} onChange={(e) => setDraft({ ...draft, [k]: e.target.value })}><option value="sent">sent (ao aceitar envio)</option><option value="delivered">delivered (ao entregar)</option></Select>
                  ) : meta.kind === "cents" ? (
                    <div className="flex items-center gap-2"><Input type="number" className="w-32" value={String(s[k] ?? 0)} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} /><span className="text-xs text-zinc-500">= {money(Number(s[k] ?? 0))}</span></div>
                  ) : (
                    <Input type="number" className="w-32" value={String(s[k] ?? 0)} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} />
                  )}
                </Field>
              </div>
              <Button className="btn-gold px-3 py-2 text-sm" disabled={!(k in draft) || save.isPending} onClick={async () => { try { await save.mutateAsync({ key: k, value: s[k] }); setDraft((d) => { const { [k]: _x, ...rest } = d; return rest; }); } catch { /* onError informa o motivo; rascunho permanece */ } }}>{save.isPending ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}</Button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
