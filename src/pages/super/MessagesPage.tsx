import { useState } from "react";
import { PlayCircle } from "lucide-react";
import { useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Button, Select, Spinner, Modal, Field, Input, useToast } from "@/components/ui";
import { H, Money, Table, Td, Tr } from "./shared";

const TONE: Record<string, "gold" | "green" | "red" | "gray" | "amber" | "blue"> = { scheduled: "amber", sending: "amber", blocked_funds: "amber", sent: "green", delivered: "green", read: "blue", failed: "red", cancelled: "gray" };

export function SuperMessages() {
  const qc = useQueryClient(); const toast = useToast();
  const [status, setStatus] = useState("");
  const [reviewJob, setReviewJob] = useState<any | null>(null);
  const [decision, setDecision] = useState<"not_sent" | "confirmed_sent">("not_sent");
  const [justification, setJustification] = useState("");
  const [providerId, setProviderId] = useState("");
  const closeReview = () => { setReviewJob(null); setJustification(""); setProviderId(""); };
  const q = useInfiniteQuery({
    queryKey: ["super-messages", status],
    initialPageParam: null as number | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (status) params.set("status", status);
      if (pageParam !== null) params.set("beforeId", String(pageParam));
      const query = params.toString();
      return api.get<{ jobs: any[]; next_before_id: number | null }>(`/super/messages${query ? `?${query}` : ""}`);
    },
    getNextPageParam: (page) => page.next_before_id ?? undefined,
    refetchInterval: (query) => (query.state.data?.pages.length ?? 0) > 1 ? false : 20_000,
  });
  const jobs = q.data?.pages.flatMap((page) => page.jobs) ?? [];
  const run = useMutation({
    mutationFn: () => api.post<any>("/super/messages/run-cron", {}),
    onSuccess: (r: any) => { toast.push("ok", `Lote executado: ${r.processed ?? 0} processados, ${r.failed ?? 0} falhas.`); qc.invalidateQueries({ queryKey: ["super-messages"] }); },
    onError: (e: any) => toast.push("err", e.message),
  });
  const resolve = useMutation({
    mutationFn: () => api.post<any>(`/super/messages/${reviewJob.id}/resolve`, {
      decision, justification,
      ...(decision === "confirmed_sent" ? { provider_message_id: providerId.trim() } : {}),
    }),
    onSuccess: () => {
      toast.push("ok", "Conciliação registrada. Verifique o extrato financeiro.");
      closeReview();
      qc.invalidateQueries({ queryKey: ["super-messages"] });
    },
    onError: (e: any) => toast.push("err", e.message),
  });
  return (
    <div>
      <H title="Fila global de mensagens" sub="Visão de operação: jobs de todas as barbearias. O cron roda sozinho — aqui você força um lote em incidentes." action={
        <div className="flex items-center gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36"><option value="">todos</option><option value="conflict">conflitos Meta</option><option value="scheduled">scheduled</option><option value="failed">failed</option><option value="sending">sending</option><option value="sent">sent</option></Select>
          <Button className="btn-gold py-2 text-sm" onClick={() => run.mutate()} disabled={run.isPending}><PlayCircle size={14} /> {run.isPending ? "rodando…" : "rodar agora"}</Button>
        </div>} />
      {q.isLoading ? <Spinner /> : q.isError && !q.data ? (
        <p role="alert" className="text-sm text-red-300">Falha ao consultar a fila. Atualize a página para tentar novamente.</p>
      ) : (
        <Table head={["#", "Barbearia", "Tipo", "Status", "Tentativas", "Agendado", "Preço", "Custo", "Erro"]}>
          {jobs.map((j: any) => (
            <Tr key={j.id}>
              <Td>{j.id}</Td><Td className="font-medium text-zinc-100">{j.slug}{j.demo === 1 && <Badge tone="blue">demo</Badge>}</Td>
              <Td className="text-xs">{j.kind}</Td>
              <Td><Badge tone={j.requires_review ? "red" : (TONE[j.status] ?? "gray")}>{j.requires_review ? "conferir" : j.status}</Badge></Td>
              <Td>{j.attempts}</Td>
              <Td className="text-xs">{j.scheduled_at?.slice(5, 16) ?? "—"}</Td>
              <Td><Money cents={j.price_cents} /></Td><Td><Money cents={j.cost_cents} /></Td>
              <Td className="max-w-[220px] text-[11px] text-red-300/80">
                <span className="block max-w-[220px] truncate" title={j.last_error || ""}>{j.last_error || ""}</span>
                {j.requires_review === 1 && <button type="button" className="mt-1 text-amber-300 underline" onClick={() => { setReviewJob(j); setDecision("not_sent"); setJustification(""); setProviderId(""); }}>Conferir envio</button>}
              </Td>
            </Tr>
          ))}
          {jobs.length === 0 && <Tr><Td className="py-6 text-zinc-500">Fila vazia neste filtro.</Td><Td /><Td /><Td /><Td /><Td /><Td /><Td /><Td /></Tr>}
        </Table>
      )}
      {q.hasNextPage && <Button className="mt-3" onClick={() => q.fetchNextPage()} disabled={q.isFetchingNextPage}>
        {q.isFetchingNextPage ? "Carregando mensagens…" : "Carregar mensagens anteriores"}
      </Button>}
      {q.isFetchNextPageError && <p role="alert" className="mt-2 text-sm text-red-300">Não foi possível carregar mensagens anteriores. Tente novamente.</p>}
      <Modal open={!!reviewJob} onClose={closeReview} title={`Conferir mensagem #${reviewJob?.id ?? ""}`}>
        <div className="space-y-3">
          <p className="text-sm text-amber-200">Resultado indeterminado: verifique o histórico do número da barbearia no provedor antes de tomar uma decisão. Nunca reenvie às cegas.</p>
          <p className="text-xs text-zinc-400">Barbearia: {reviewJob?.slug ?? "—"} · Crédito reservado: <Money cents={reviewJob?.price_cents ?? 0} /></p>
          <Field label="Resultado verificado">
            <Select value={decision} onChange={(e) => setDecision(e.target.value as "not_sent" | "confirmed_sent")}>
              <option value="not_sent">Confirmei que NÃO foi enviada — liberar reserva</option>
              <option value="confirmed_sent">Confirmei envio na Meta — registrar ID e aplicar política de cobrança</option>
            </Select>
          </Field>
          {decision === "confirmed_sent" && <Field label="ID oficial da mensagem (wamid...)"><Input value={providerId} onChange={(e) => setProviderId(e.target.value)} placeholder="wamid.HBg..." /></Field>}
          <Field label="Justificativa e evidência (mín. 20 caracteres)">
            <textarea className="w-full rounded-xl border border-line bg-ink p-3 text-sm text-zinc-100" rows={4} value={justification} onChange={(e) => setJustification(e.target.value)} placeholder="Onde e como o resultado foi conferido?" />
          </Field>
          <Button className="btn-gold w-full justify-center py-2" disabled={resolve.isPending || justification.trim().length < 20 || (decision === "confirmed_sent" && !/^wamid[.][A-Za-z0-9._:-]{6,}$/.test(providerId.trim()))} onClick={() => resolve.mutate()}>
            {resolve.isPending ? "Registrando..." : "Registrar conciliação"}
          </Button>
        </div>
      </Modal>
    </div>
  );
}
