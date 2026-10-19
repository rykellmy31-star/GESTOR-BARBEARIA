import { useState, type ReactNode } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { Bell, Calendar, ChevronRight, LayoutDashboard, LogOut, Menu, MessageSquare, Scissors, Settings as SettingsIcon, ShieldCheck, Sparkles, Store, Tag, Users, X, ClipboardList, Wallet, UsersRound } from "lucide-react";
import { clsx } from "clsx";
import { useAuth, useConfig, useNotifications } from "@/lib/hooks";
import { siteBase } from "@/lib/api";
import { Badge, EmptyState, Modal, Spinner } from "@/components/ui";
import { fmtDateTime } from "@/lib/format";

export function RequireRole({ children }: { children: ReactNode }) {
  return <>{children}</>; // gate moved para <Gate> em App.tsx (RBAC também no servidor)
}

export function NotificationsBell({ panel }: { panel: "admin" | "barber" }) {
  const tz = "America/Bahia";
  const { data } = useConfig();
  const { data: n, markAll } = useNotifications(panel);
  const [open, setOpen] = useState(false);
  const unread = n?.unread ?? 0;
  const list = n?.notifications ?? [];
  const markLabel = (t: string) => (t === "booking" ? "Novo" : t === "cancel" ? "Cancelamento" : t === "block_request" ? "Bloqueio" : t === "order" ? "Pedido" : t === "billing" ? "Créditos" : t === "message" ? "WhatsApp" : t === "connection" ? "Conexão" : "Sistema");
  return (
    <>
      <button onClick={() => setOpen(true)} className="relative rounded-xl border border-line p-2 text-zinc-300 transition-colors hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]" aria-label="Notificações">
        <Bell size={17} />
        {unread > 0 && (
          <>
            <span className="notif-ping absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-red-500" />
            <span className="absolute -right-1.5 -top-1.5 flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-bold text-white">{unread > 9 ? "9+" : unread}</span>
          </>
        )}
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Notificações">
        {list.length === 0 ? (
          <EmptyState icon={<Bell size={28} />} title="Nenhuma notificação por aqui" text="Novos agendamentos, cancelamentos, pedidos e alertas de créditos aparecem automaticamente aqui." />
        ) : (
          <ul className="space-y-2.5">
            {list.slice(0, 25).map((x: any) => (
              <li key={x.id} className={clsx("rounded-xl border p-3 text-sm", x.read_at ? "border-line bg-ink-soft opacity-70" : "border-[color-mix(in_srgb,var(--c-gold)_35%,transparent)] bg-gold-soft")}>
                <div className="mb-1 flex items-center justify-between gap-2">
                  <p className="font-semibold text-zinc-100">{x.title}</p>
                  <Badge tone={x.kind === "cancel" ? "red" : x.kind === "block_request" ? "amber" : x.kind === "billing" ? "blue" : "gold"}>{markLabel(x.kind)}</Badge>
                </div>
                <p className="text-zinc-300">{x.body}</p>
                <p className="mt-1.5 text-[11px] text-zinc-500">{fmtDateTime(x.created_at, data?.settings.timezone || tz)}</p>
              </li>
            ))}
          </ul>
        )}
        {unread > 0 && (
          <div className="mt-4 flex justify-end">
            <button className="text-sm text-[var(--c-gold)] hover:underline" onClick={() => markAll.mutate()}>
              Marcar todas como lidas ({unread})
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}

const adminNav = [
  { to: "dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "agenda", label: "Agenda", icon: Calendar },
  { to: "equipe", label: "Equipe", icon: UsersRound },
  { to: "barbeiros", label: "Profissionais", icon: Scissors },
  { to: "servicos", label: "Serviços", icon: Tag },
  { to: "produtos", label: "Produtos & Estoque", icon: Store },
  { to: "pedidos", label: "Pedidos", icon: ClipboardList },
  { to: "clientes", label: "Clientes", icon: Users },
  { to: "mensagens", label: "WhatsApp", icon: MessageSquare },
  { to: "carteira", label: "Carteira de créditos", icon: Wallet },
  { to: "configuracoes", label: "Configurações", icon: SettingsIcon },
  { to: "demonstracao", label: "Demonstração", icon: Sparkles },
];

export function AdminLayout() {
  const { me, logout } = useAuth();
  const navigate = useNavigate();
  const { data: cfg } = useConfig();
  const base = siteBase();
  const [menu, setMenu] = useState(false);
  const user = me.data;
  const Side = (
    <nav className="space-y-1">
      {adminNav.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          onClick={() => setMenu(false)}
          className={({ isActive }) =>
            clsx("flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-sm transition-colors", isActive ? "bg-gold-soft font-semibold text-[var(--c-gold)]" : "text-zinc-400 hover:bg-ink-soft hover:text-zinc-100")
          }
        >
          <Icon size={16} className="shrink-0" />
          {label}
          <ChevronRight size={13} className="ml-auto opacity-0 transition-opacity group-hover:opacity-60" />
        </NavLink>
      ))}
    </nav>
  );
  return (
    <div className="texture min-h-screen">
      <div className="mx-auto flex max-w-[1500px]">
        <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-line bg-ink-soft p-4 lg:flex">
          <div className="mb-6 flex items-center gap-2.5 px-1">
            <Scissors className="h-6 w-6 text-[var(--c-gold)]" />
            <div>
              <p className="font-display text-[17px] leading-tight text-zinc-50">{cfg?.settings.shop_name ?? "Painel"}</p>
              <p className="text-[10px] uppercase tracking-[0.25em] text-[var(--c-gold)]">Painel da barbearia</p>
            </div>
          </div>
          {Side}
          <div className="mt-auto space-y-2 border-t border-line pt-4">
            <a href={`${base}`} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-xl px-3 py-2 text-sm text-zinc-400 hover:bg-ink-soft hover:text-zinc-100">
              <ChevronRight size={15} /> Ver site público
            </a>
            <div className="flex items-center gap-2 text-sm text-zinc-300">
              <ShieldCheck size={15} className="text-[var(--c-gold)]" />
              <span className="truncate">{user?.name}</span>
            </div>
            <button className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-zinc-400 hover:bg-ink-soft hover:text-red-300" onClick={() => logout.mutateAsync().then(() => navigate("/login"))}>
              <LogOut size={15} /> Sair
            </button>
          </div>
        </aside>
        <div className="flex-1">
          <header className="sticky top-0 z-40 flex h-14 items-center gap-3 border-b border-line bg-ink px-4 backdrop-blur">
            <button className="rounded-lg border border-line p-2 text-zinc-300 lg:hidden" onClick={() => setMenu(true)}><Menu size={17} /></button>
            <p className="font-display text-base text-zinc-100">{cfg?.settings.shop_name} <span className="text-zinc-500">· Admin</span></p>
            <div className="ml-auto flex items-center gap-2">
              <NotificationsBell panel="admin" />
              <button className="rounded-lg border border-line p-2 text-zinc-400 lg:hidden" onClick={() => logout.mutateAsync().then(() => navigate("/login"))}><LogOut size={16} /></button>
            </div>
          </header>
          {menu && (
            <div className="fixed inset-0 z-50 bg-black/70 lg:hidden" onClick={() => setMenu(false)}>
              <div className="h-full w-64 border-r border-line bg-ink p-4" onClick={(e) => e.stopPropagation()}>
                <div className="mb-4 flex items-center justify-between">
                  <p className="font-display text-zinc-100">Menu</p>
                  <button onClick={() => setMenu(false)}><X size={17} className="text-zinc-400" /></button>
                </div>
                {Side}
              </div>
            </div>
          )}
          <main className="p-4 pb-20 sm:p-6">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}

export { Spinner };
