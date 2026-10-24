import { Link, Navigate } from "react-router-dom";
import { ArrowRight, Plus, Scissors } from "lucide-react";
import { useAuth } from "@/lib/hooks";

export function CompanyPickerPage() {
  const { user } = useAuth();
  const companies = user?.companies ?? [];
  if (user?.platform_role !== "superadmin" && companies.length === 1) {
    const c = companies[0];
    return <Navigate replace to={`/c/${c.slug}/${c.role === "barber" ? "painel" : "admin"}`} />;
  }
  return (
    <div className="texture min-h-screen px-4 py-14">
      <div className="mx-auto max-w-lg">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2"><Scissors className="h-6 w-6 text-[var(--c-gold)]" /><span className="font-display text-xl text-zinc-50">tigu</span></Link>
        <h1 className="font-display text-2xl text-zinc-50">Suas barbearias</h1>
        <p className="mt-1 text-sm text-zinc-500">Escolha para entrar no painel.</p>
        <ul className="mt-6 space-y-3">
          {companies.map((c) => (
            <li key={c.slug}>
              <Link to={`/c/${c.slug}/${c.role === "barber" ? "painel" : "admin"}`} className="flex items-center gap-3 rounded-2xl border border-line bg-panel p-4 transition-colors hover:border-[var(--c-gold)]">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold text-zinc-100">{c.name}</p>
                  <p className="text-[11px] uppercase tracking-wide text-zinc-500">{c.role} · plano {c.plan}{c.status === "suspended" ? " · SUSPENSA" : ""}</p>
                </div>
                <ArrowRight size={18} className="text-[var(--c-gold)]" />
              </Link>
            </li>
          ))}
          {user?.platform_role === "superadmin" && (
            <li><Link to="/superadmin" className="flex items-center gap-3 rounded-2xl border border-sky-500/40 bg-sky-500/5 p-4 hover:border-sky-400">
              <p className="flex-1 font-semibold text-sky-200">Suíte Tigu (plataforma)</p><ArrowRight size={18} className="text-sky-300" /></Link></li>
          )}
        </ul>
        {(user?.platform_role === "superadmin" || companies.some(c => c.role === "owner")) && <Link to="/comecar" className="btn-gold mt-6 flex w-full items-center justify-center gap-2 rounded-xl py-3 text-sm"><Plus size={16} /> Cadastrar nova barbearia</Link>}
      </div>
    </div>
  );
}
