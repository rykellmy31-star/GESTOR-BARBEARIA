import { useState } from "react";
import { Link } from "react-router-dom";
import { Loader2, MailCheck, Scissors } from "lucide-react";
import { useAuth } from "@/lib/hooks";
import { Button, Field, Input } from "@/components/ui";

export function RecoverPage() {
  const { recover, recoverVerify } = useAuth();
  const [mode, setMode] = useState<"request" | "verify">("request");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const [demoCode, setDemoCode] = useState("");
  const [err, setErr] = useState("");

  const doRequest = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try { const r = await recover.mutateAsync(email); setMsg(r.message); if (r.demo_code) setDemoCode(r.demo_code); setMode("verify"); }
    catch (e2: any) { setErr(e2.message); }
  };
  const doVerify = async (e: React.FormEvent) => {
    e.preventDefault(); setErr("");
    try { await recoverVerify.mutateAsync({ email, code, password }); setMsg("Senha redefinida. Faça login com a nova senha."); }
    catch (e2: any) { setErr(e2.message); }
  };

  return (
    <div className="texture grid min-h-screen place-items-center px-4">
      <form onSubmit={mode === "request" ? doRequest : doVerify} className="card-luxe w-full max-w-md rounded-2xl border border-line bg-panel p-8">
        <Link to="/" className="mb-6 flex items-center justify-center gap-2"><Scissors className="h-6 w-6 text-[var(--c-gold)]" /><span className="font-display text-xl text-zinc-50">tigu</span></Link>
        <h1 className="font-display text-xl text-zinc-50">Recuperar acesso</h1>
        <div className="mt-6 space-y-4">
        <Field label="E-mail da conta"><Input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        {mode === "verify" && (
          <>
            <Field label="Código de recuperação"><Input value={code} onChange={(e) => setCode(e.target.value)} placeholder="XXXXXXXXXX" /></Field>
            <Field label="Nova senha (10+ caracteres)"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          </>
        )}
        </div>
        {demoCode && <p className="mt-3 rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs text-sky-200">Modo demonstração — seu código: <b className="font-mono">{demoCode}</b> (em produção ele seria entregue por um canal seguro).</p>}
        {msg && <p className="mt-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200"><MailCheck size={13} className="mr-1 inline" />{msg}</p>}
        {err && <p className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</p>}
        <Button className="btn-gold mt-5 w-full justify-center py-3" disabled={recover.isPending || recoverVerify.isPending}>
          {mode === "request" ? <>Gerar código {recover.isPending && <Loader2 size={15} className="ml-1 animate-spin" />}</> : <>Redefinir senha</>}
        </Button>
        <p className="mt-4 text-center text-xs text-zinc-500">Perdeu o acesso à empresa? O suporte Tigu pode verificar sua identidade e gerar um código.</p>
      </form>
    </div>
  );
}
