import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { KeyRound, Loader2, LockKeyhole, Scissors } from "lucide-react";
import { useAuth } from "@/lib/hooks";
import { Button, Field, Input, useToast } from "@/components/ui";

/** Obrigatória após reset manual pelo suporte Tigu. */
export function ChangePasswordPage() {
  const { user, me, changePassword, refetchMe } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError("");
    if (next.length < 10 || next !== confirm || current === next) {
      setError("A nova senha precisa ter 10 ou mais caracteres, ser diferente da atual e coincidir com a confirmação.");
      return;
    }
    try {
      await changePassword.mutateAsync({ current, next });
      await refetchMe();
      toast.push("ok", "Senha atualizada. Sua sessão está protegida.");
      navigate(user?.platform_role === "superadmin" ? "/superadmin" : "/selecionar", { replace: true });
    } catch (e: any) {
      setError(e?.message || "Não foi possível trocar a senha.");
    }
  }

  return (
    <div className="texture grid min-h-screen place-items-center px-4 py-10">
      <div className="w-full max-w-md">
        <Link to="/" className="mb-8 flex items-center justify-center gap-2 font-display text-xl text-zinc-100">
          <Scissors size={21} className="text-[var(--c-gold)]" /> tigu
        </Link>
        {me.isLoading ? <p className="text-center text-sm text-zinc-400">Verificando sua conta…</p> :
          !user ? <div className="rounded-2xl border border-line bg-panel p-6 text-center text-sm text-zinc-300">Faça login para alterar sua senha. <Link to="/login" className="text-[var(--c-gold)] underline">Entrar</Link></div> :
          <form onSubmit={submit} className="card-luxe space-y-4 rounded-2xl border border-line bg-panel p-6 sm:p-8">
            <div className="flex items-center gap-2 text-[var(--c-gold)]"><LockKeyhole size={23} /><span className="text-xs font-semibold uppercase tracking-wider">Segurança de acesso</span></div>
            <h1 className="font-display text-2xl text-zinc-100">Altere sua senha</h1>
            <p className="text-sm text-zinc-400">
              {user.must_change_password
                ? "A senha provisória fornecida pelo suporte precisa ser alterada antes de acessar o sistema."
                : "Defina uma nova senha para proteger sua conta do Tigu."}
            </p>
            <Field label="Senha atual ou provisória"><Input type="password" autoComplete="current-password" required value={current} onChange={e => setCurrent(e.target.value)} /></Field>
            <Field label="Nova senha (mín. 10 caracteres)"><Input type="password" autoComplete="new-password" minLength={10} required value={next} onChange={e => setNext(e.target.value)} /></Field>
            <Field label="Confirme a nova senha"><Input type="password" autoComplete="new-password" minLength={10} required value={confirm} onChange={e => setConfirm(e.target.value)} /></Field>
            {error && <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">{error}</p>}
            <Button className="btn-gold w-full justify-center gap-2 py-3" disabled={changePassword.isPending}>
              {changePassword.isPending ? <Loader2 size={16} className="animate-spin" /> : <KeyRound size={16} />} Salvar nova senha
            </Button>
          </form>}
      </div>
    </div>
  );
}
