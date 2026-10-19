import { useState } from "react";
import { PlayCircle } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Select, Spinner, useToast } from "@/components/ui";
import { H, Money, Table, Td, Tr } from "./shared";

const TONE: Record<string, "gold" | "green" | "red" | "gray" | "amber" | "blue"> = { scheduled: "amber", sent: "green", delivered: "green", read: "blue", failed: "red", cancelled: "gray" };

export function SuperMessages() {
  const qc = useQueryClient(); const toast = useToast();
  const [status, setStatus] = useState("");
  const q = useQuery({ queryKey: ["super-messages", status], queryFn: () => api.get<any>(`/super/messages${status ? `?status=${status}` : ""}`).then((d) => d.jobs as any[]), refetchInterval: 20_000 });
  const run = useMutation({
    mutationFn: () => api.post<any>("/super/messages/run-cron", {}),
    onSuccess: (r: any) => { toast.push("ok", `Lote executado: ${r.processed ?? 0} processados, ${r.failed ?? 0} falhas.`); qc.invalidateQueries({ queryKey: ["super-messages"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  return (
    <div>
      <H title="Fila global de mensagens" sub="Visão de operação: jobs de todas as barbearias. O cron roda sozinho — aqui você força um lote em incidentes." action={
        <div className="flex items-center gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36"><option value="">todos</option><option value="scheduled">scheduled</option><option value="failed">failed</option><option value="sent">sent</option></Select>
          <Button className="btn-gold py-2 text-sm" onClick={() => run.mutate()} disabled={run.isPending}><PlayCircle size={14} /> {run.isPending ? "rodando…" : "rodar agora"}</Button>
        </div>} />
      {q.isLoading ? <Spinner /> : (
        <Table head={["#", "Barbearia", "Tipo", "Status", "Tentativas", "Agendado", "Preço", "Custo", "Erro"]}>
          {(q.data ?? []).map((j: any) => (
            <Tr key={j.id}>
              <Td>{j.id}</Td><Td className="font-medium text-zinc-100">{j.slug}{j.demo === 1 && <Badge tone="blue">demo</Badge>}</Td>
              <Td className="text-xs">{j.kind}</Td>
              <Td><Badge tone={TONE[j.status] ?? "gray"}>{j.status}</Badge></Td>
              <Td>{j.attempts}</Td>
              <Td className="text-xs">{j.scheduled_at?.slice(5, 16) ?? "—"}</Td>
              <Td><Money cents={j.price_cents} /></Td><Td><Money cents={j.cost_cents} /></Td>
              <Td className="max-w-[220px] truncate text-[11px] text-red-300/80">{j.last_error || ""}</Td>
            </Tr>
          ))}
          {(q.data ?? []).length === 0 && <Tr><Td className="py-6 text-zinc-500">Fila vazia neste filtro.</Td><Td /><Td /><Td /><Td /><Td /><Td /><Td /><Td /></Tr>}
        </Table>
      )}
    </div>
  );
}
