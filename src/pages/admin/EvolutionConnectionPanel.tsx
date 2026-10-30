import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, QrCode, RefreshCw, Smartphone, Unplug } from "lucide-react";
import { api } from "@/lib/api";
import { Badge, Button, useToast } from "@/components/ui";

type Status = { configured:boolean; active:boolean; status:string; instance?:string|null; companyName?:string; reason?:string|null; error?:string|null };

export function EvolutionConnectionPanel({ onChange }: { onChange: () => void }) {
  const [qr, setQr] = useState<string | null>(null);
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ["wa", "evolution"],
    queryFn: () => api.get<Status>("/admin/whatsapp/evolution/status"),
    refetchInterval: (query) => query.state.data?.active && query.state.data?.status !== "connected" ? 8000 : false,
  });
  const status = q.data;
  useEffect(() => {
    if (status?.status === "connected") {
      setQr(null);
      // Confirma no D1 com POST autenticado; o GET de status não faz escrita.
      void api.post("/admin/whatsapp/check", {}).then(onChange).catch(() => {});
    }
    // Notificar a consulta principal apenas quando o estado da integração mudou.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.status]);
  const reload = async () => {
    await qc.invalidateQueries({ queryKey: ["wa", "evolution"] });
    onChange();
  };
  const start = useMutation({
    mutationFn: () => api.post<{ qr?:string|null }>("/admin/whatsapp/evolution/start", {}),
    onSuccess: async (r) => {
      setQr(r.qr || null);
      toast.push("info", "Instância criada. Escaneie o QR Code com seu WhatsApp.");
      await reload();
    },
    onError: (e:Error) => toast.push("err",e.message),
  });
  const getQr = useMutation({
    mutationFn: () => api.post<{ qr:string|null; message?:string|null }>("/admin/whatsapp/evolution/qr", {}),
    onSuccess: (r) => { setQr(r.qr || null); if (!r.qr) toast.push("info",r.message || "QR ainda não disponível."); },
    onError: (e:Error) => toast.push("err",e.message),
  });
  const disconnect = useMutation({
    mutationFn: () => api.post("/admin/whatsapp/evolution/disconnect", {}),
    onSuccess: async () => { setQr(null); toast.push("ok","Sessão Evolution desconectada."); await reload(); },
    onError: (e:Error) => toast.push("err",e.message),
  });

  return (
    <section className="rounded-2xl border border-emerald-500/30 bg-panel p-5">
      <header className="flex flex-wrap items-center gap-2">
        <Smartphone className="text-emerald-300" size={19}/>
        <h2 className="font-display text-lg text-zinc-100">Evolution API — conectar por QR Code</h2>
        <Badge tone={status?.status==="connected"?"green":status?.active?"amber":"gray"}>
          {status?.status==="connected"?"WhatsApp conectado":status?.active?"Aguardando conexão":"Não conectado"}
        </Badge>
      </header>
      <p className="mt-2 text-xs leading-relaxed text-zinc-400">
        Cada barbearia conecta seu próprio número. Conecte pelo QR Code e gerencie sua sessão diretamente no painel.
      </p>
      <p className="mt-2 text-xs text-zinc-400">
        <strong>Barbearia:</strong> {status?.companyName||"Carregando…"}
        {status?.instance && <span className="mt-1 block break-all text-zinc-500">
          Identificador exclusivo da conexão: {status.instance}
        </span>}
      </p>
      {!status?.configured ? (
        <p className="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
          {status?.reason || "A configuração da Evolution API ainda não foi reconhecida pelo Worker oficial."}
          {" "}A URL e os segredos são administrados pela CR Jornada na Cloudflare; o proprietário não precisa digitá-los.
        </p>
      ) : (
        <div className="mt-4 flex flex-wrap gap-2">
          {!status?.active ? (
            <Button className="btn-gold flex items-center gap-2 px-4 py-2 text-sm"
              onClick={() => start.mutate()} disabled={start.isPending}>
              {start.isPending?<Loader2 className="animate-spin" size={15}/>:<QrCode size={15}/>}
              Criar conexão WhatsApp
            </Button>
          ) : (
            <>
              {status.status!=="connected" && (
                <Button className="btn-gold flex items-center gap-2 px-4 py-2 text-sm" onClick={() => getQr.mutate()} disabled={getQr.isPending}>
                  {getQr.isPending?<Loader2 className="animate-spin" size={15}/>:<QrCode size={15}/>}
                  Gerar / atualizar QR
                </Button>
              )}
              <Button className="flex items-center gap-1.5 border border-line px-4 py-2 text-sm" onClick={() => reload()}><RefreshCw size={14}/> Verificar</Button>
              <Button className="flex items-center gap-1.5 border border-red-500/30 px-4 py-2 text-sm text-red-200"
                onClick={() => { if (window.confirm("Desconectar este WhatsApp da Evolution API?")) disconnect.mutate(); }}
                disabled={disconnect.isPending}><Unplug size={14}/> Desconectar</Button>
            </>
          )}
        </div>
      )}
      {qr && status?.active && status.status!=="connected" && (
        <div className="mt-4 rounded-xl border border-line bg-white p-4 text-center sm:w-72">
          <img src={qr} width={240} height={240} className="mx-auto max-w-full" alt="QR Code para conectar WhatsApp" />
          <p className="mt-2 text-xs text-zinc-900">WhatsApp → Aparelhos conectados → Conectar aparelho</p>
        </div>
      )}
      {status?.error && <p className="mt-2 text-xs text-amber-200">{status.error}</p>}

    </section>
  );
}
