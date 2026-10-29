import { useEffect, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { Bot, Building2, Coins, FileClock, LayoutDashboard, LogOut, Tag, Receipt, Scissors, Settings, Users, Handshake, CreditCard, Plug, Menu, X } from "lucide-react";
import { useAuth } from "@/lib/hooks";

const links = [
  { to: "overview", label: "Visão geral", icon: LayoutDashboard },
  { to: "companies", label: "Barbearias", icon: Building2 },
  { to: "leads", label: "Interessados", icon: Handshake },
  { to: "users", label: "Usuários", icon: Users },
  { to: "wallets", label: "Carteiras", icon: Coins },
  { to: "topups", label: "Recargas & estornos", icon: Receipt },
  { to: "subscription-invoices", label: "Faturas Pix anteriores", icon: CreditCard },
  { to: "pricing", label: "Precificação", icon: Tag },
  { to: "messages", label: "Fila global", icon: Bot },
  { to: "audit", label: "Auditoria", icon: FileClock },
  { to: "settings", label: "Config. plataforma", icon: Settings },
  { to: "integrations", label: "Integrações", icon: Plug },
];

export function SuperLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const [menuOpen, setMenuOpen] = useState(false);

  // Ao mudar de aba no celular, libera o scroll e fecha a navegação.
  useEffect(() => { setMenuOpen(false); }, [pathname]);
  useEffect(() => {
    if (!menuOpen) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const exit = () => {
    setMenuOpen(false);
    logout.mutateAsync(undefined as any).then(() => navigate("/login")).catch(() => navigate("/login"));
  };

  const navigation = (close: boolean) => (
    <nav aria-label="Páginas do Super Admin" className="mt-5 flex-1 space-y-0.5 overflow-y-auto">
      {links.map((l) => (
        <NavLink key={l.to} to={l.to} end={l.to === "overview"}
          onClick={close ? () => setMenuOpen(false) : undefined}
          className={({ isActive }) => `flex min-h-11 items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors ${isActive ? "bg-gold-soft font-semibold text-[var(--c-gold)]" : "text-zinc-300 hover:bg-white/5 hover:text-zinc-100"}`}>
          <l.icon size={17} className="shrink-0" /> {l.label}
        </NavLink>
      ))}
    </nav>
  );

  const footer = () => (
    <div className="border-t border-[#26262f] pt-3 text-xs">
      <p className="truncate font-semibold text-zinc-200">{user?.name}</p>
      <p className="truncate text-zinc-500">{user?.email}</p>
      <div className="mt-3 flex gap-2">
        <button onClick={() => { setMenuOpen(false); navigate("/selecionar"); }}
          className="rounded-lg border border-line px-3 py-2 text-zinc-300 hover:text-zinc-100">Painéis</button>
        <button onClick={exit} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-line px-3 py-2 text-zinc-300 hover:border-red-500/50 hover:text-red-300">
          <LogOut size={14} /> Sair
        </button>
      </div>
    </div>
  );

  return (
    <div className="texture min-h-screen min-w-0 bg-[#0a0a0c]">
      {/* Desktop: barra lateral fixa. */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 flex-col border-r border-[#26262f] bg-[#101014] p-4 lg:flex">
        <div className="flex items-center gap-2 px-1">
          <Scissors className="h-6 w-6 text-[var(--c-gold)]" />
          <div><p className="font-display text-lg leading-none text-zinc-50">tigu</p>
            <p className="mt-0.5 text-[9px] uppercase tracking-[0.3em] text-zinc-500">suíte da plataforma</p></div>
        </div>
        {navigation(false)}
        {footer()}
      </aside>

      <div className="min-w-0 lg:pl-56">
        {/* Mobile: cabeçalho compacto + menu acessível, sem navegação horizontal quebrada. */}
        <header className="sticky top-0 z-30 flex h-16 w-full min-w-0 items-center justify-between gap-3 border-b border-[#26262f] bg-[#101014]/95 px-4 backdrop-blur lg:hidden">
          <div className="flex min-w-0 items-center gap-2">
            <Scissors size={20} className="shrink-0 text-[var(--c-gold)]" />
            <span className="truncate font-display text-lg text-white">TIGU · Super Admin</span>
          </div>
          <button type="button" aria-label="Abrir menu do Super Admin" aria-expanded={menuOpen}
            aria-controls="tigu-super-mobile-nav" onClick={() => setMenuOpen(true)}
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-xl border border-[#45454d] text-zinc-100">
            <Menu size={22} />
          </button>
        </header>
        {menuOpen && (
          <div className="fixed inset-0 z-50 lg:hidden" role="presentation">
            <button type="button" aria-label="Fechar menu" onClick={() => setMenuOpen(false)}
              className="absolute inset-0 bg-black/75" />
            <aside id="tigu-super-mobile-nav" role="dialog" aria-modal="true"
              aria-label="Menu do Super Admin"
              className="absolute inset-y-0 left-0 flex w-[min(19rem,88vw)] max-w-full flex-col bg-[#101014] p-4 shadow-2xl">
              <div className="flex items-center justify-between gap-2">
                <span className="font-display text-lg text-zinc-50">TIGU · Menu</span>
                <button type="button" aria-label="Fechar menu" onClick={() => setMenuOpen(false)}
                  className="inline-flex h-11 w-11 items-center justify-center rounded-xl border border-line text-zinc-100"><X size={20}/></button>
              </div>
              {navigation(true)}
              {footer()}
            </aside>
          </div>
        )}
        <main className="mx-auto w-full min-w-0 max-w-6xl px-3 py-5 sm:px-6 sm:py-7">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
