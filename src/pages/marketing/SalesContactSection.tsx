import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, Mail, MessageCircle } from "lucide-react";
import { api } from "@/lib/api";

type PublicSalesContact = {
  enabled: boolean;
  whatsapp: string;
  email: string;
  title: string;
  message: string;
};

/** Nunca divulga um número falso: só exibe contato salvo pelo superadministrador. */
export function SalesContactSection() {
  const query = useQuery({
    queryKey: ["public-marketing-contact"],
    queryFn: () => api.get<{ contact: PublicSalesContact }>("/marketing/contact"),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: true,
  });
  const contact = query.data?.contact;
  if (!contact?.enabled || (!contact.whatsapp && !contact.email)) return null;

  const whatsAppUrl = contact.whatsapp
    ? `https://wa.me/${contact.whatsapp}?text=${encodeURIComponent(contact.message)}`
    : null;
  const mailUrl = contact.email
    ? `mailto:${contact.email}?subject=${encodeURIComponent("Dúvidas sobre os planos do Tigu")}`
    : null;

  return (
    <section id="contato-comercial" className="mx-auto max-w-6xl px-4 py-12 sm:px-6" aria-labelledby="sales-contact-title">
      <div className="rounded-3xl border border-[var(--c-gold)]/40 bg-[#17161c] p-6 text-center shadow-xl shadow-black/20 sm:p-10">
        <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--c-gold)]">Atendimento comercial</p>
        <h2 id="sales-contact-title" className="font-display text-2xl text-zinc-50 sm:text-3xl">{contact.title}</h2>
        <p className="mx-auto mt-3 max-w-xl text-sm leading-relaxed text-zinc-400">
          Antes de escolher seu plano, converse diretamente com o responsável pelo Tigu.
          Tire dúvidas sobre contratação, recursos e funcionamento do sistema.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-3">
          {whatsAppUrl && (
            <a href={whatsAppUrl} target="_blank" rel="noopener noreferrer"
              className="btn-gold inline-flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-sm font-semibold">
              <MessageCircle size={17} /> Tirar dúvidas no WhatsApp <ArrowUpRight size={15} />
            </a>
          )}
          {mailUrl && (
            <a href={mailUrl}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-[#3b3b43] px-5 py-3 text-sm font-medium text-zinc-200 transition hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]">
              <Mail size={17} /> Falar por e-mail
            </a>
          )}
        </div>
      </div>
    </section>
  );
}
