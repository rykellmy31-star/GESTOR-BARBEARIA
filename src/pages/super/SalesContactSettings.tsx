import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ExternalLink, Mail, MessageCircle, Save } from "lucide-react";
import { api } from "@/lib/api";
import { useToast } from "@/components/ui";

export type SalesContact = {
  enabled: boolean;
  whatsapp: string;
  email: string;
  title: string;
  message: string;
};

const EMPTY: SalesContact = {
  enabled: false,
  whatsapp: "",
  email: "",
  title: "Ficou alguma dúvida antes de contratar?",
  message: "Olá! Conheci o Tigu e gostaria de tirar algumas dúvidas sobre os planos.",
};

export function SalesContactSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  const query = useQuery({
    queryKey: ["super-marketing-contact"],
    queryFn: () => api.get<{ contact: SalesContact }>("/marketing/contact"),
  });
  const [draft, setDraft] = useState<SalesContact>(EMPTY);
  const [changed, setChanged] = useState(false);

  useEffect(() => {
    if (query.data?.contact && !changed) setDraft(query.data.contact);
  }, [query.data, changed]);

  const save = useMutation({
    mutationFn: (values: SalesContact) =>
      api.put<{ contact: SalesContact }>("/marketing/contact", values),
    onSuccess: (data) => {
      setDraft(data.contact);
      setChanged(false);
      void qc.invalidateQueries({ queryKey: ["super-marketing-contact"] });
      toast.push("ok", "Contato comercial atualizado na plataforma.");
    },
    onError: (error: Error) => toast.push("err", error.message),
  });
  const update = <K extends keyof SalesContact>(field: K, value: SalesContact[K]) => {
    setDraft((old) => ({ ...old, [field]: value }));
    setChanged(true);
  };

  return (
    <section className="mb-8 max-w-3xl rounded-2xl border border-[var(--c-gold)]/30 bg-[#16161c] p-4 sm:p-6" aria-labelledby="sales-contact-heading">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sales-contact-heading" className="font-display text-xl text-zinc-100">Contato da página de vendas</h2>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-zinc-400">
            Cadastre seu WhatsApp e/ou e-mail para que interessados nos planos do Tigu possam tirar dúvidas antes de contratar. As alterações são refletidas automaticamente no site conectado ao Worker.
          </p>
        </div>
        <a href="/" target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs font-medium text-[#d4af37] hover:underline">
          Ver página de vendas <ExternalLink size={13} />
        </a>
      </div>

      {query.isLoading ? <p className="mt-5 text-sm text-zinc-400">Carregando contato comercial…</p>
        : query.isError ? (
          <div role="alert" className="mt-5 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-200">
            Não foi possível carregar os dados. Confira a API/D1 da homologação e tente novamente.
            <button className="ml-2 underline" onClick={() => void query.refetch()}>Tentar novamente</button>
          </div>
        ) : (
          <form className="mt-5 space-y-4" onSubmit={(event) => { event.preventDefault(); save.mutate(draft); }}>
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-[#303039] bg-[#111115] px-4 py-3">
              <input type="checkbox" checked={draft.enabled}
                onChange={(event) => update("enabled", event.target.checked)}
                className="h-4 w-4 accent-[#d4af37]" />
              <span className="text-sm text-zinc-200">Exibir contato comercial na página de vendas</span>
            </label>
            <div className="grid gap-4 md:grid-cols-2">
              <label className="block text-xs text-zinc-300">
                <span className="mb-2 flex items-center gap-2"><MessageCircle size={15} className="text-[#d4af37]" /> WhatsApp comercial</span>
                <input value={draft.whatsapp} onChange={(e) => update("whatsapp", e.target.value)}
                  inputMode="tel" autoComplete="tel" placeholder="5573999999999"
                  maxLength={32}
                  className="input-dark w-full" />
                <span className="mt-1 block text-[11px] text-zinc-500">Digite DDI + DDD + número. Ex.: 55 + 73 + telefone.</span>
              </label>
              <label className="block text-xs text-zinc-300">
                <span className="mb-2 flex items-center gap-2"><Mail size={15} className="text-[#d4af37]" /> E-mail comercial (opcional)</span>
                <input type="email" value={draft.email}
                  onChange={(e) => update("email", e.target.value)}
                  placeholder="contato@seudominio.com"
                  maxLength={120} className="input-dark w-full" />
              </label>
            </div>
            <label className="block text-xs text-zinc-300">
              <span className="mb-2 block">Título da área de contato</span>
              <input value={draft.title} onChange={(e) => update("title", e.target.value)}
                minLength={10} maxLength={110} required className="input-dark w-full" />
            </label>
            <label className="block text-xs text-zinc-300">
              <span className="mb-2 block">Mensagem pronta para o WhatsApp</span>
              <textarea value={draft.message} onChange={(e) => update("message", e.target.value)}
                minLength={8} maxLength={250} required rows={3}
                className="input-dark w-full resize-y" />
            </label>
            {draft.enabled && !draft.whatsapp && !draft.email &&
              <p role="alert" className="text-xs text-amber-300">Informe pelo menos um contato antes de ativar a publicação.</p>}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="max-w-md text-[11px] text-zinc-500">
                Seu contato ficará público quando ativado. Nenhum número fictício será publicado antes de você salvar.
              </p>
              <button type="submit" disabled={save.isPending || (draft.enabled && !draft.whatsapp && !draft.email)}
                className="btn-gold inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold disabled:opacity-50">
                <Save size={15} /> {save.isPending ? "Salvando…" : "Salvar contato"}
              </button>
            </div>
          </form>
        )}
    </section>
  );
}
