import { useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { KeyRound, Loader2, Scissors } from "lucide-react";
import { useAuth } from "@/lib/hooks";
import { Button, Field, Input, useToast } from "@/components/ui";

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const toast = useToast();

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const res = await login.mutateAsync({ email, password });
      toast.push("ok", `Bem-vindo, ${res.user.name.split(" ")[0]}!`);
      // Não permitir URL externa, nem contornar troca de senha obrigatória.
      const requestedNext = params.get("next") || "";
      const allowedNext = /^\/(?:superadmin|selecionar|c\/[a-z0-9-]+\/(?:admin|painel))(?:\/|$)/.test(requestedNext);
      // Nunca direcionar profissional para /admin apenas porque a URL pediu.
      const requestedRole = res.companies.find(c => requestedNext.startsWith(`/c/${c.slug}/`));
      const safeNext = allowedNext && !(requestedRole?.role === "barber" && requestedNext.startsWith(`/c/${requestedRole.slug}/admin`))
        ? requestedNext : "";
      navigate(res.user.must_change_password ? "/alterar-senha" : (safeNext || res.next || "/selecionar"), { replace: true });
    } catch (e2: any) {
      setErr(e2.message || "Falha na autenticação");
    }
  };

  return (
    <div className="texture grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2">
          <Scissors className="h-7 w-7 text-[var(--c-gold)]" />
          <span className="font-display text-2xl tracking-wide text-zinc-50">tigu</span>
          <span className="mt-1 text-[9px] uppercase tracking-[0.3em] text-zinc-500">para barbearias</span>
        </Link>
        <form onSubmit={submit} className="card-luxe rounded-2xl border border-line bg-panel p-6 sm:p-8">
          <h1 className="font-display text-xl text-zinc-50">Entrar na sua conta</h1>
          <p className="mt-1 text-xs text-zinc-500">Um login para todas as barbearias que você atende.</p>
          <div className="mt-6 space-y-4">
          <Field label="E-mail"><Input type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
          <Field label="Senha"><Input type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </div>
          {err && <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</p>}
          <Button className="btn-gold mt-6 w-full justify-center py-3" disabled={login.isPending}>
            {login.isPending ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />} Entrar
          </Button>
          <div className="mt-4 flex items-center justify-between text-xs text-zinc-500">
            <Link to="/recuperar" className="hover:text-[var(--c-gold)]">Esqueci a senha</Link>
            <Link to="/comecar" className="font-semibold text-[var(--c-gold)] hover:underline">Criar barbearia grátis →</Link>
          </div>
        </form>
      </div>
    </div>
  );
}
