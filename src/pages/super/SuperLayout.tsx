import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Bot, Building2, Coins, FileClock, LayoutDashboard, LogOut, Tag, Receipt, Scissors, Settings, Users, Handshake } from "lucide-react";
import { useAuth } from "@/lib/hooks";

const links = [
  { to: "overview", label: "Visão geral", icon: LayoutDashboard },
  { to: "companies", label: "Barbearias", icon: Building2 },
  { to: "leads", label: "Interessados", icon: Handshake },
  { to: "users", label: "Usuários", icon: Users },
  { to: "wallets", label: "Carteiras", icon: Coins },
  { to: "topups", label: "Recargas & estornos", icon: Receipt },
  { to: "pricing", label: "Precificação", icon: Tag },
  { to: "messages", label: "Fila global", icon: Bot },
  { to: "audit", label: "Auditoria", icon: FileClock },
  { to: "settings", label: "Config. plataforma", icon: Settings },
];

export function SuperLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="texture min-h-screen bg-[#0a0a0c]">
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-56 flex-col border-r border-[#26262f] bg-[#101014] p-4 lg:flex">
        <div className="flex items-center gap-2 px-1">
          <Scissors className="h-6 w-6 text-[var(--c-gold)]" />
          <div><p className="font-display text-lg leading-none text-zinc-50">tigu</p><p className="mt-0.5 text-[9px] uppercase tracking-[0.3em] text-zinc-500">suíte da plataforma</p></div>
        </div>
        <nav className="mt-6 flex-1 space-y-0.5">
          {links.map((l) => (
            <NavLink key={l.to} to={l.to} end={l.to === "overview"} className={({ isActive }) => `flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm transition-colors ${isActive ? "bg-gold-soft font-semibold text-[var(--c-gold)]" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-100"}`}>
              <l.icon size={15} /> {l.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-[#26262f] pt-3 text-xs">
          <p className="truncate font-semibold text-zinc-200">{user?.name}</p>
          <p className="truncate text-zinc-500">{user?.email}</p>
          <div className="mt-2 flex gap-2">
            <button onClick={() => navigate("/selecionar")} className="rounded-lg border border-line px-2 py-1 text-zinc-400 hover:text-zinc-100">Painéis</button>
            <button onClick={() => { logout.mutateAsync(undefined as any).then(() => navigate("/login")).catch(() => navigate("/login")); }} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-zinc-400 hover:border-red-500/50 hover:text-red-300"><LogOut size={11} /> sair</button>
          </div>
        </div>
      </aside>
      <div className="lg:pl-56">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 overflow-x-auto border-b border-[#26262f] bg-[#0a0a0c]/90 px-4 backdrop-blur lg:hidden">
          {links.map((l) => <NavLink key={l.to} to={l.to} end={l.to === "overview"} className={({ isActive }) => `whitespace-nowrap rounded-lg px-2.5 py-1.5 text-xs ${isActive ? "bg-gold-soft font-semibold text-[var(--c-gold)]" : "text-zinc-400"}`}><l.icon size={13} className="mr-1 inline" />{l.label}</NavLink>)}
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6"><Outlet /></main>
      </div>
    </div>
  );
}
