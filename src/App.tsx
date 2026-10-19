import type React from "react";
import { Navigate, Outlet, Route, Routes, useParams } from "react-router-dom";
import { PublicLayout } from "./components/layout/PublicLayout";
import { HomePage } from "./pages/public/HomePage";
import { BookingPage } from "./pages/public/BookingPage";
import { MyBookingsPage } from "./pages/public/MyBookingsPage";
import { AdminLayout, RequireRole } from "./components/layout/PanelLayout";
import { DashboardPage } from "./pages/admin/DashboardPage";
import { AgendaPage } from "./pages/admin/AgendaPage";
import { BarbersPage } from "./pages/admin/BarbersPage";
import { ServicesPage } from "./pages/admin/ServicesPage";
import { ProductsPage } from "./pages/admin/ProductsPage";
import { OrdersPage } from "./pages/admin/OrdersPage";
import { CustomersPage } from "./pages/admin/CustomersPage";
import { SettingsPage } from "./pages/admin/SettingsPage";
import { DemoPage } from "./pages/admin/DemoPage";
import { TeamPage } from "./pages/admin/TeamPage";
import { WalletPage } from "./pages/admin/WalletPage";
import { MessagesPage } from "./pages/admin/MessagesPage";
import { BarberPanelPage } from "./pages/barber/BarberPanelPage";
import { LoginPage } from "./pages/auth/LoginPage";
import { RegisterPage } from "./pages/auth/RegisterPage";
import { RecoverPage } from "./pages/auth/RecoverPage";
import { CompanyPickerPage } from "./pages/auth/CompanyPickerPage";
import { LandingPage } from "./pages/marketing/LandingPage";
import { PreviewPage } from "./pages/marketing/PreviewPage";
import { DeveloperCredit } from "./components/layout/DeveloperCredit";
import { SuperLayout } from "./pages/super/SuperLayout";
import { SuperOverview } from "./pages/super/OverviewPage";
import { SuperCompanies } from "./pages/super/CompaniesPage";
import { SuperCompanyDetail } from "./pages/super/CompanyDetailPage";
import { SuperUsers } from "./pages/super/UsersPage";
import { SuperWallets } from "./pages/super/TopupsPage";
import { SuperPricing } from "./pages/super/PricingPage";
import { SuperTopups } from "./pages/super/TopupsPage";
import { SuperMessages } from "./pages/super/MessagesPage";
import { SuperAudit } from "./pages/super/AuditPage";
import { SuperSettings } from "./pages/super/SettingsPage";
import { useAuth, useCompanyRole } from "./lib/hooks";
import { Spinner } from "./components/ui";

function Gate({ need, children }: { need: "login" | "admin" | "barber" | "super"; children: React.ReactNode }) {
  const { me } = useAuth();
  const params = useParams();
  const role = useCompanyRole(me.data ?? undefined);
  if (me.isLoading) return <div className="grid min-h-screen place-items-center"><Spinner label="Verificando acesso…" /></div>;
  const user = me.data ?? null;
  if (need === "super") {
    if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
    if (user.platform_role !== "superadmin") return <NoAccess what="Acesso restrito à equipe Tigu." />;
    return <>{children}</>;
  }
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname)}`} replace />;
  if (need === "login") return <>{children}</>;
  const isSuper = user.platform_role === "superadmin";
  if (need === "admin") {
    if (!isSuper && (role?.role !== "owner" && role?.role !== "manager")) {
      if (role?.role === "barber") return <Navigate to={`/c/${params.slug}/painel`} replace />;
      return <NoAccess what="Sua conta não é dona/gerente desta barbearia." />;
    }
    return <>{children}</>;
  }
  // barber
  if (!isSuper && role?.role !== "barber" && role?.role !== "owner" && role?.role !== "manager") {
    return <NoAccess what="Sua conta não está vinculada a um profissional desta barbearia." />;
  }
  return <>{children}</>;
}

function NoAccess({ what }: { what: string }) {
  return (
    <div className="grid min-h-screen place-items-center px-6 text-center">
      <div>
        <p className="font-display text-2xl text-zinc-100">Acesso negado</p>
        <p className="mt-2 max-w-md text-sm text-zinc-400">{what}</p>
        <a href="/selecionar" className="btn-gold mt-6 inline-flex rounded-xl px-5 py-2.5 text-sm">Escolher outra barbearia</a>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <>
      <Routes>
      {/* plataforma */}
      <Route path="/" element={<LandingPage />} />
      <Route path="/preview" element={<PreviewPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/comecar" element={<RegisterPage />} />
      <Route path="/recuperar" element={<RecoverPage />} />
      <Route path="/selecionar" element={<Gate need="login"><CompanyPickerPage /></Gate>} />

      {/* barbearia (tenant) — público */}
      <Route path="/c/:slug" element={<PublicLayout />}>
        <Route index element={<HomePage />} />
        <Route path="agendar" element={<BookingPage />} />
        <Route path="meus-agendamentos" element={<MyBookingsPage />} />
      </Route>

      {/* barbearia — painel do dono/gerente */}
      <Route path="/c/:slug/admin" element={<Gate need="admin"><AdminLayout /></Gate>}>
        <Route index element={<Navigate to="dashboard" replace />} />
        <Route path="dashboard" element={<DashboardPage />} />
        <Route path="agenda" element={<AgendaPage />} />
        <Route path="equipe" element={<TeamPage />} />
        <Route path="barbeiros" element={<BarbersPage />} />
        <Route path="servicos" element={<ServicesPage />} />
        <Route path="produtos" element={<ProductsPage />} />
        <Route path="pedidos" element={<OrdersPage />} />
        <Route path="clientes" element={<CustomersPage />} />
        <Route path="mensagens" element={<MessagesPage />} />
        <Route path="carteira" element={<WalletPage />} />
        <Route path="configuracoes" element={<SettingsPage />} />
        <Route path="demonstracao" element={<DemoPage />} />
      </Route>

      {/* barbearia — painel do profissional */}
      <Route path="/c/:slug/painel" element={<Gate need="barber"><BarberPanelPage /></Gate>} />

      {/* suspenso → página honesta */}
      {/* suíte Tigu */}
      <Route path="/superadmin" element={<Gate need="super"><SuperLayout /></Gate>}>
        <Route index element={<Navigate to="overview" replace />} />
        <Route path="overview" element={<SuperOverview />} />
        <Route path="companies" element={<SuperCompanies />} />
        <Route path="companies/:id" element={<SuperCompanyDetail />} />
        <Route path="users" element={<SuperUsers />} />
        <Route path="wallets" element={<SuperWallets />} />
        <Route path="pricing" element={<SuperPricing />} />
        <Route path="topups" element={<SuperTopups />} />
        <Route path="messages" element={<SuperMessages />} />
        <Route path="audit" element={<SuperAudit />} />
        <Route path="settings" element={<SuperSettings />} />
      </Route>

      <Route path="/admin" element={<Navigate to="/login" replace />} />
      <Route path="/painel" element={<Navigate to="/login" replace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <DeveloperCredit />
    </>
  );
}
