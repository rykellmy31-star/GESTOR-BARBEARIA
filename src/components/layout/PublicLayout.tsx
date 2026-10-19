import { useEffect, useState } from "react";
import { Link, Outlet, useLocation } from "react-router-dom";
import { Instagram, MapPin, Menu, MessageCircle, Phone, ShoppingBag, Scissors, X, CalendarClock } from "lucide-react";
import { clsx } from "clsx";
import { siteBase, cartKey, cartEvent } from "@/lib/api";
import { useConfig } from "@/lib/hooks";
import { Badge } from "@/components/ui";

export function CartBadge() {
  const [, setTick] = useState(0);
  useEffect(() => {
    const h = () => setTick((t) => t + 1);
    window.addEventListener(cartEvent(), h);
    return () => window.removeEventListener(cartEvent(), h);
  }, []);
  const cart = JSON.parse(localStorage.getItem(cartKey()) || "{}") as Record<string, number>;
  const count = Object.values(cart).reduce((a, b) => a + b, 0);
  if (!count) return null;
  return (
    <span className="absolute -right-1.5 -top-1.5 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-[var(--c-gold)] px-1 text-[10px] font-bold text-black">
      {count}
    </span>
  );
}

export function PublicLayout() {
  const { data } = useConfig();
  const s = data?.settings;
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const loc = useLocation();
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 24);
    h();
    window.addEventListener("scroll", h, { passive: true });
    return () => window.removeEventListener("scroll", h);
  }, []);
  useEffect(() => setOpen(false), [loc.pathname]);

  const nav = [
    { to: "#servicos", label: "Serviços" },
    { to: "#barbeiros", label: "Barbeiros" },
    { to: "#loja", label: "Loja" },
    { to: "#avaliacoes", label: "Avaliações" },
    { to: "#contato", label: "Contato" },
  ];
  const base = /^\/c\//.test(loc.pathname) ? loc.pathname.split("/").slice(0, 3).join("/") : "";

  return (
    <div className="texture min-h-screen">
      {data?.demo_active && (
        <div className="bg-[var(--c-gold)] px-3 py-1.5 text-center text-[11px] font-bold uppercase tracking-wider text-black">
          Ambiente de demonstração — dados fictícios, removíveis pelo painel administrativo
        </div>
      )}
      <header className={clsx("fixed inset-x-0 z-50 transition-all duration-300", scrolled || open ? "border-b border-line bg-ink backdrop-blur-md" : "bg-transparent")}>
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-4 px-4 sm:px-6">
          <Link to={base || "/"} className="flex items-center gap-2.5">
            {s?.logo_url ? (
              <img src={s.logo_url} alt="logo" className="h-9 w-9 object-contain" />
            ) : (
              <Scissors className="h-7 w-7 text-[var(--c-gold)]" />
            )}
            <div className="leading-tight">
              <p className="font-display text-lg font-semibold tracking-wide text-zinc-50">{s?.shop_name ?? "…"}</p>
              <p className="text-[9.5px] uppercase tracking-[0.3em] text-[var(--c-gold)]">Barbearia</p>
            </div>
          </Link>
          <nav className="ml-auto hidden items-center gap-6 lg:flex">
            {nav.map((n) => (
              <a key={n.to} href={base + n.to} className="text-sm text-zinc-300 transition-colors hover:text-[var(--c-gold)]">{n.label}</a>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-1.5 lg:ml-4">
            <Link to={`${base}/#loja`.replace("#loja", "")} onClick={() => { setTimeout(() => document.getElementById("loja")?.scrollIntoView({ behavior: "smooth" }), 60); }} className="relative rounded-xl border border-line p-2.5 text-zinc-300 transition-colors hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]" aria-label="Carrinho">
              <ShoppingBag size={17} />
              <CartBadge />
            </Link>
            {s?.whatsapp && s.whatsapp_buttons_enabled !== false && (
              <a href={`https://wa.me/${s.whatsapp}`} target="_blank" rel="noreferrer" className="hidden rounded-xl border border-line p-2.5 text-zinc-300 transition-colors hover:border-[var(--c-gold)] hover:text-[var(--c-gold)] sm:block" aria-label="WhatsApp">
                <MessageCircle size={17} />
              </a>
            )}
            <Link to="agendar" className="btn-gold ml-1 hidden rounded-xl px-4 py-2 text-sm sm:inline-flex">
              <CalendarClock size={15} /> Agendar
            </Link>
            <button className="rounded-xl border border-line p-2.5 text-zinc-300 lg:hidden" onClick={() => setOpen((v) => !v)} aria-label="Menu">
              {open ? <X size={18} /> : <Menu size={18} />}
            </button>
          </div>
        </div>
        {open && (
          <div className="border-t border-line bg-ink px-6 py-4 lg:hidden">
            {nav.map((n) => (
              <a key={n.to} href={base + n.to} className="block py-2.5 text-[15px] text-zinc-200" onClick={() => setOpen(false)}>{n.label}</a>
            ))}
            <Link to="meus-agendamentos" className="block py-2.5 text-[15px] text-zinc-200">Meus agendamentos</Link>
            <Link to="agendar" className="btn-gold mt-3 flex w-full rounded-xl py-2.5 text-sm justify-center">Agendar meu horário</Link>
          </div>
        )}
      </header>
      <main>
        <Outlet />
      </main>
      <footer className="border-t border-line bg-ink-soft" id="contato">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-3">
          <div>
            <div className="flex items-center gap-2">
              <Scissors className="h-6 w-6 text-[var(--c-gold)]" />
              <p className="font-display text-xl text-zinc-100">{s?.shop_name}</p>
            </div>
            <p className="mt-3 max-w-xs text-sm leading-relaxed text-zinc-400">{s?.about}</p>
            <div className="mt-4 flex gap-3">
              {s?.instagram && <a href={s.instagram} target="_blank" rel="noreferrer" className="rounded-lg border border-line p-2 text-zinc-300 hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]" aria-label="Instagram"><Instagram size={16} /></a>}
              {s?.facebook && <a href={s.facebook} target="_blank" rel="noreferrer" className="rounded-lg border border-line p-2 text-zinc-300 hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]" aria-label="Facebook"><ShoppingBag size={16} className="hidden" /><MessageCircle size={16} /></a>}
              {s?.whatsapp && <a href={`https://wa.me/${s.whatsapp}`} target="_blank" rel="noreferrer" className="rounded-lg border border-line p-2 text-zinc-300 hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]" aria-label="WhatsApp"><Phone size={16} /></a>}
            </div>
          </div>
          <div className="text-sm text-zinc-400">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.3em] text-[var(--c-gold)]">Contato</p>
            <p className="flex items-start gap-2"><MapPin size={15} className="mt-0.5 shrink-0 text-[var(--c-gold)]" />{s?.address}</p>
            <p className="mt-2 flex items-center gap-2"><Phone size={14} className="text-[var(--c-gold)]" />{s?.phone}</p>
            <p className="mt-2"><Link to="meus-agendamentos" className="underline decoration-[var(--c-gold)]/40 underline-offset-4 hover:text-[var(--c-gold)]">Meus agendamentos / remarcar / cancelar</Link></p>
            <p className="mt-2"><Link to="/admin" className="text-zinc-500 underline decoration-dotted underline-offset-4 hover:text-[var(--c-gold)]">Área do proprietário</Link></p>
          </div>
          <div className="text-sm text-zinc-400">
            <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.3em] text-[var(--c-gold)]">Horários</p>
            {s && <OpeningHours settings={s} />}
          </div>
        </div>
        <div className="border-t border-line py-4 text-center text-xs text-zinc-600">
          © {new Date().getFullYear()} {s?.shop_name} · Sistema de agendamento profissional — React · Workers · D1
          {" "}<Badge tone="gray">v1.0</Badge>
        </div>
              <div className="mx-auto mt-8 max-w-6xl border-t border-line px-4 pt-5 sm:px-6">
          <p className="flex items-center justify-center gap-1.5 text-[11px] text-zinc-600">
            Agenda &amp; automações por <a href="/" className="font-semibold text-zinc-400 hover:text-[var(--c-gold)]">Tigu</a>
          </p>
        </div>
      </footer>
      {/* botão flutuante WhatsApp */}
      {s?.whatsapp && s.whatsapp_buttons_enabled !== false && (
        <a
          href={`https://wa.me/${s.whatsapp}?text=${encodeURIComponent("Olá! Vim pelo site da barbearia.")}`}
          target="_blank" rel="noreferrer"
          className="fixed bottom-5 right-5 z-40 flex h-12 w-12 items-center justify-center rounded-full bg-[#1faa53] p-3.5 text-white shadow-[0_12px_34px_-8px_rgba(31,170,83,.65)] transition-transform hover:scale-110"
          aria-label="Falar no WhatsApp"
        >
          <MessageCircle size={22} />
        </a>
      )}
    </div>
  );
}

export function OpeningHours({ settings }: { settings: NonNullable<ReturnType<typeof useConfig>["data"]>["settings"] }) {
  const names = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
  return (
    <ul className="space-y-1">
      {[1, 2, 3, 4, 5, 6, 0].map((d) => {
        const h = settings.opening_hours?.[String(d)];
        return (
          <li key={d} className="flex justify-between">
            <span>{names[d]}</span>
            <span className={h ? "text-zinc-200" : "text-red-400"}>{h ? `${h.open} – ${h.close}` : "Fechado"}</span>
          </li>
        );
      })}
    </ul>
  );
}
