import { useState } from "react";
import { BadgeCheck, RotateCcw } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Field, Input, Select, Spinner, useToast } from "@/components/ui";
import { H, Money, Table, Td, Tr } from "./shared";

const TONE: Record<string, "gold" | "green" | "red" | "gray" | "amber"> = { paid: "green", pending: "amber", expired: "gray", cancelled: "gray", failed: "red" };

export function SuperTopups() {
  const qc = useQueryClient(); const toast = useToast();
  const [status, setStatus] = useState("pending");
  const [just, setJust] = useState<Record<number, string>>({});
  const q = useQuery({ queryKey: ["super-topups", status], queryFn: () => api.get<any>(`/super/topups?status=${status}`).then((d) => d.topups as any[]) });
  const confirm = useMutation({
    mutationFn: ({ id, why }: { id: number; why: string }) => api.post<any>(`/super/topups/${id}/confirm`, { justification: why }),
    onSuccess: (r) => { toast.push("ok", r.credited ? "Créditos liberados." : r.note || "Ok"); qc.invalidateQueries({ queryKey: ["super-topups"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  return (
    <div>
      <H title="Recargas Pix" sub="Crédito manual só com comprovante verificado no gateway + justificativa — idempotente: nunca credita 2×." action={<Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-40"><option value="">todas</option><option value="pending">pendentes</option><option value="paid">pagas</option><option value="expired">expiradas</option><option value="cancelled">canceladas</option></Select>} />
      {q.isLoading ? <Spinner /> : q.isError ? (
        <div role="alert" className="rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">Não foi possível consultar recargas. <button className="ml-2 underline" onClick={() => void q.refetch()}>Tentar novamente</button></div>
      ) : (
        <Table head={["Código", "Empresa", "Valor", "Provedor", "Status", "Criada", "Ação"]}>
          {(q.data ?? []).map((t: any) => (
            <Tr key={t.id}>
              <Td className="font-mono text-xs">{t.code}</Td><Td>{t.company_name}</Td><Td><Money cents={t.amount_cents} /></Td>
              <Td className="text-xs">{t.provider}</Td><Td><Badge tone={TONE[t.status] ?? "gray"}>{t.status}</Badge></Td>
              <Td className="text-xs">{t.created_at?.slice(0, 16)}</Td>
              <Td>
                {t.status === "pending" ? (
                  <div className="flex items-center gap-1.5">
                    <Input placeholder="justificativa…" value={just[t.id] ?? ""} onChange={(e) => setJust({ ...just, [t.id]: e.target.value })} className="w-40 py-1 text-xs" />
                    <Button className="rounded-lg border border-emerald-500/50 px-2 py-1 text-xs text-emerald-300" disabled={(just[t.id] ?? "").length < 10 || confirm.isPending} onClick={() => confirm.mutate({ id: t.id, why: just[t.id] })}><BadgeCheck size={12} /> creditar</Button>
                  </div>
                ) : <span className="text-xs text-zinc-600">—</span>}
              </Td>
            </Tr>
          ))}
          {(q.data ?? []).length === 0 && <Tr><Td className="py-6 text-center text-zinc-500" >Nada neste filtro.</Td><Td /><Td /><Td /><Td /><Td /><Td /></Tr>}
        </Table>
      )}
    </div>
  );
}

/** Aba combinada no menu: "Recargas & Refunds" */
export function SuperWallets() {
  const qc = useQueryClient(); const toast = useToast();
  const [status, setStatus] = useState("");
  const jobs = useQuery({ queryKey: ["super-jobs-failed", status], queryFn: () => api.get<any>(`/super/messages${status ? `?status=${status}` : ""}`).then((d) => d.jobs as any[]) });
  const [just, setJust] = useState<Record<number, string>>({});
  const refund = useMutation({
    mutationFn: ({ id, why }: { id: number; why: string }) => api.post<any>(`/super/jobs/${id}/refund`, { justification: why }),
    onSuccess: (r) => { toast.push("ok", r.note || "Estorno aplicado (idempotente)."); qc.invalidateQueries({ queryKey: ["super-jobs-failed"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  return (
    <div>
      <SuperTopups />
      <h2 className="mb-2 mt-8 font-display text-lg text-zinc-100">Estornos de mensagens cobradas</h2>
      <p className="mb-3 text-xs text-zinc-500">Crédito manual por envio específico (raro: falha pós-cobrança que o retry automático não resolveu). <Select value={status} onChange={(e) => setStatus(e.target.value)} className="ml-2 rounded-lg border border-line bg-panel px-2 py-1 text-xs"><option value="">fila completa</option><option value="failed">falhas</option><option value="scheduled">agendadas</option></Select></p>
      {jobs.isLoading ? <Spinner /> : jobs.isError ? (
        <div role="alert" className="rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">Não foi possível consultar estornos. <button className="ml-2 underline" onClick={() => void jobs.refetch()}>Tentar novamente</button></div>
      ) : (
        <Table head={["#", "Empresa", "Tipo", "Status", "Preço", "Custo", "Estornar"]}>
          {(jobs.data ?? []).filter((j: any) => j.captured_at || j.status === "failed").slice(0, 40).map((j: any) => (
            <Tr key={j.id}>
              <Td>{j.id}</Td><Td>{j.slug}</Td><Td className="text-xs">{j.kind}</Td>
              <Td><Badge tone={j.status === "failed" ? "red" : "green"}>{j.status}</Badge></Td>
              <Td><Money cents={j.price_cents} /></Td><Td><Money cents={j.cost_cents} /></Td>
              <Td>{j.captured_at && !j.demo ? (
                <div className="flex items-center gap-1.5">
                  <Input placeholder="motivo…" value={just[j.id] ?? ""} onChange={(e) => setJust({ ...just, [j.id]: e.target.value })} className="w-36 py-1 text-xs" />
                  <button className="inline-flex items-center gap-1 rounded-lg border border-amber-500/50 px-2 py-1 text-[11px] text-amber-300 hover:bg-amber-500/10" disabled={(just[j.id] ?? "").trim().length < 10 || refund.isPending} onClick={() => { if (confirm(`Estornar ${j.id}?`)) refund.mutate({ id: j.id, why: just[j.id] }); }}><RotateCcw size={11} /> estornar</button>
                </div>
              ) : <span className="text-xs text-zinc-600">{j.demo ? "demo (grátis)" : "não cobrada"}</span>}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </div>
  );
}
