import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eraser, KeyRound, RefreshCw, Sparkles, Trash2 } from "lucide-react";
import { api } from "@/lib/api";
import { Badge, Button, ConfirmDialog, Modal, Spinner, useToast } from "@/components/ui";

export function DemoPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["demo-status"], queryFn: () => api.get<any>("/admin/demo/status") });
  const [confirmDel, setConfirmDel] = useState(false);
  const [creds, setCreds] = useState<any[] | null>(null);

  const reseed = useMutation({
    mutationFn: () => api.post<any>("/admin/demo/reseed", {}),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["demo-status"] });
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["admin-barbers"] });
      const ins = r.summary?.inserted ?? {};
      setCreds(r.summary?.barber_credentials ?? []);
      toast.push("ok", `Demo (re)gerada: ${ins.barbers ?? "?"} barbeiros · ${ins.services ?? "?"} serviços · ${ins.bookings ?? "?"} reservas · ${ins.orders ?? "?"} pedidos.`);
    },
    onError: (e: any) => toast.push("err", e.message),
  });
  const del = useMutation({
    mutationFn: () => api.del<any>("/admin/demo"),
    onSuccess: (r: any) => {
      qc.invalidateQueries({ queryKey: ["demo-status"] });
      qc.invalidateQueries({ queryKey: ["config"] });
      qc.invalidateQueries({ queryKey: ["admin-barbers"] });
      setConfirmDel(false);
      toast.push("ok", r?.message ?? "Demo removida.");
    },
    onError: (e: any) => toast.push("err", e.message),
  });

  const counts = q.data?.counts ?? {};
  const active = q.data?.active;

  return (
    <div className="max-w-3xl space-y-5">
      <div>
        <h1 className="flex items-center gap-2 font-display text-2xl text-zinc-50"><Sparkles size={20} className="text-[var(--c-gold)]" /> Modo demonstração</h1>
        <p className="text-xs text-zinc-500">Tudo que a demo cria recebe a marca <Badge tone="gray">demo=1</Badge> e pode ser apagado com um clique, sem tocar nos dados reais.</p>
      </div>

      <div className="rounded-2xl border border-line bg-panel p-5">
        {q.isLoading ? <Spinner /> : active ? (
          <div className="mb-4 grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
            {Object.entries(counts).map(([t, n]) => (
              <div key={t} className="rounded-xl border border-line bg-ink-soft px-3 py-2 text-center">
                <p className="font-display text-xl text-[var(--c-gold)]">{n as number}</p>
                <p className="text-[10.5px] uppercase tracking-wide text-zinc-500">{t}</p>
              </div>
            ))}
          </div>
        ) : (
          <p className="mb-4 rounded-xl border border-line bg-ink-soft p-3 text-sm text-zinc-400">Nenhum dado de demonstração no banco — o site está operando apenas com o cadastro real.</p>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="rounded-xl border border-line p-4">
            <p className="mb-1 font-semibold text-zinc-100"><RefreshCw size={14} className="mr-1.5 inline text-[var(--c-gold)]" />Gerar / repopular demo</p>
            <p className="mb-3 text-[12px] leading-relaxed text-zinc-500">Idempotente: catálogo, 21 dias de agenda (10h–21h, horário local), pedidos, avaliações, folgas e clientes fictícios. <b className="text-zinc-400">Cada execução gera novas senhas para os barbeiros demo.</b></p>
            <Button className="w-full justify-center" disabled={reseed.isPending} onClick={() => reseed.mutate()}>{reseed.isPending ? "Gerando no D1…" : "Executar seed de demonstração"}</Button>
            {active ? <p className="mt-2 text-[11px] text-zinc-600">Demo já aplicada — reexecutar substitui a agenda fictícia e redefine credenciais.</p> : null}
          </div>
          <div className="rounded-xl border border-red-900/60 bg-red-950/20 p-4">
            <p className="mb-1 font-semibold text-red-200"><Trash2 size={14} className="mr-1.5 inline" />Remover toda a demonstração</p>
            <p className="mb-3 text-[12px] leading-relaxed text-red-200/70">
              Apaga barbeiros/serviços/produtos/clientes/pedidos/avaliações/bloqueios marcados como demo. Recursos citados por atendimentos <b>reais</b> são desativados em vez de apagados, preservando histórico e faturamento.
            </p>
            <Button variant="danger" className="w-full justify-center" disabled={!active || del.isPending} onClick={() => setConfirmDel(true)}><Eraser size={14} /> Remover dados de demonstração</Button>
            {!active && <p className="mt-1.5 text-center text-[11px] text-zinc-600">nada a remover agora</p>}
          </div>
        </div>
      </div>

      <div className="rounded-2xl border border-line bg-panel p-5 text-[13px] leading-relaxed text-zinc-400">
        <p className="mb-1 font-semibold text-zinc-200">Como a demo entra no sistema</p>
        <ul className="list-disc space-y-1 pl-5">
          <li>No <b>onboarding</b> (criação do 1º admin), marcando “popular com dados de demonstração”.</li>
          <li>Aqui, a qualquer momento — ou por linha de comando: <code className="text-[var(--c-gold)]">npx tsx scripts/seed.mjs --local|--remote</code>. Todos usam o mesmo motor (<code>api/lib/demo-seed.ts</code>).</li>
          <li>Cada linha carrega <code>demo=1</code>; enquanto houver dados demo o site mostra a tarja “ambiente de demonstração” (some ao remover).</li>
          <li>Credenciais dos barbeiros demo são geradas a cada execução e mostradas só nesse momento (como num onboarding real).</li>
        </ul>
      </div>

      <Modal open={Boolean(creds)} onClose={() => setCreds(null)} title="Credenciais dos barbeiros demo">
        <p className="mb-3 text-xs text-zinc-500">Anote agora — o sistema não guarda senhas em claro e estes acessos valem até o próximo reseed.</p>
        <ul className="space-y-1.5">
          {(creds ?? []).map((c: any, i: number) => (
            <li key={i} className="flex items-center gap-2 rounded-xl border border-line bg-ink-soft px-3 py-2 font-mono text-[12.5px]">
              <KeyRound size={13} className="text-[var(--c-gold)]" />
              <span className="w-24 truncate text-zinc-300">{c.name}</span>
              <span className="text-zinc-400">{c.email}</span>
              <span className="ml-auto select-all text-[var(--c-gold)]">{c.password}</span>
            </li>
          ))}
        </ul>
        <p className="mt-3 text-[11px] text-zinc-600">Acesso em <b>/admin</b>: o login de barbeiro cai automaticamente no painel individual (<b>/painel</b>).</p>
        <Button className="mt-4 w-full justify-center" onClick={() => setCreds(null)}>Guardei aqui</Button>
      </Modal>

      <ConfirmDialog open={confirmDel} onCancel={() => setConfirmDel(false)} onConfirm={() => del.mutate()} danger
        title="Apagar TODOS os dados de demonstração?" text="Barbeiros demo, agenda fictícia, pedidos, avaliações e clientes fictícios serão removidos permanentemente. Dados reais não são tocados. Esta ação não tem desfazer." />
    </div>
  );
}
