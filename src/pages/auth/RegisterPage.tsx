import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Check, Loader2, Rocket, Scissors } from "lucide-react";
import { useAuth } from "@/lib/hooks";
import { Button, Field, Input, useToast } from "@/components/ui";

const perks = ["Site de agendamento com a sua cara", "Agenda sem conflito, mesmo em horário de pico", "Loja de produtos com estoque", "Equipe com painel próprio"];

export function RegisterPage() {
  const { register } = useAuth();
  const navigate = useNavigate();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [f, setF] = useState({ shop: "", name: "", email: "", phone: "", password: "", confirm: "" });
  const [err, setErr] = useState("");

  const can1 = f.shop.trim().length >= 3;
  const can2 = f.name.trim().length >= 2 && /\S+@\S+\.\w+/.test(f.email) && f.password.length >= 10 && f.password === f.confirm;

  const submit = async () => {
    setErr("");
    try {
      const res = await register.mutateAsync({ company_name: f.shop.trim(), name: f.name.trim(), email: f.email.trim(), password: f.password, phone: f.phone.trim() });
      toast.push("ok", "Teste grátis do Tigu iniciado por 15 dias! Nenhuma cobrança agora.");
      navigate(res.next, { replace: true });
    } catch (e: any) {
      setErr(e.message || "Não foi possível concluir o cadastro");
    }
  };

  return (
    <div className="texture min-h-screen px-4 py-10">
      <div className="mx-auto max-w-5xl">
        <Link to="/" className="mb-8 inline-flex items-center gap-2">
          <Scissors className="h-6 w-6 text-[var(--c-gold)]" />
          <span className="font-display text-xl text-zinc-50">tigu</span>
        </Link>
        <div className="grid gap-8 lg:grid-cols-[1.2fr_1fr]">
          <div className="card-luxe rounded-2xl border border-line bg-panel p-6 sm:p-8">
            <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-[var(--c-gold)]">Teste grátis por 15 dias · passo {step + 1} de 2</p>
            <h1 className="mt-2 font-display text-2xl text-zinc-50">{step === 0 ? "Como se chama a sua barbearia?" : "Crie o seu acesso de dono"}</h1>
            {step === 0 ? (
              <div className="mt-6 space-y-4">
                <Field label="Nome da barbearia"><Input autoFocus placeholder="Ex.: Barbearia Navalha de Ouro" value={f.shop} onChange={(e) => setF({ ...f, shop: e.target.value })} /></Field>
                <Field label="Telefone/WhatsApp de contato (opcional)"><Input placeholder="(75) 99999-0000" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} /></Field>
                <Button className="btn-gold w-full justify-center py-3" disabled={!can1} onClick={() => setStep(1)}>Continuar</Button>
              </div>
            ) : (
              <div className="mt-6 space-y-4">
                <Field label="Seu nome"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
                <Field label="E-mail (será o seu login)"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
                <Field label="Senha (mín. 10 caracteres)"><Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
                <Field label="Repita a senha"><Input type="password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
                {err && <p className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-300">{err}</p>}
                <Button className="btn-gold w-full justify-center py-3" disabled={!can2 || register.isPending} onClick={submit}>
                  {register.isPending ? <Loader2 size={16} className="animate-spin" /> : <Rocket size={16} />} Iniciar teste grátis de 15 dias
                </Button>
                <button className="w-full text-center text-xs text-zinc-500 hover:text-zinc-300" onClick={() => setStep(0)}>← voltar</button>
              </div>
            )}
            <p className="mt-5 text-[11px] leading-relaxed text-zinc-500">
              Ao criar a conta você aceita a <a href="#termos" className="underline">política de uso</a> da plataforma. Seus dados ficam isolados por
              empresa e podem ser exportados/anonymizados quando você pedir (LGPD).
            </p>
          </div>
          <aside className="lg:pt-10">
            <h2 className="font-display text-lg text-zinc-100">O que já vem ligado</h2>
            <ul className="mt-4 space-y-3 text-sm text-zinc-300">
              {perks.map((p) => (<li key={p} className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-[var(--c-gold)]" /> {p}</li>))}
              <li className="flex gap-2"><Check size={16} className="mt-0.5 shrink-0 text-[var(--c-gold)]" /> Lembretes de WhatsApp 1h antes — só com o seu número autorizado</li>
            </ul>
            <p className="mt-6 rounded-xl border border-line bg-ink-soft p-4 text-xs leading-relaxed text-zinc-400">
              Seu teste do Tigu Start é gratuito durante 15 dias, sem cadastrar cartão. Depois, o Start custa R$ 19,99/mês e pode ser pago por Pix no painel da barbearia — não há débito automático. O WhatsApp é ativado no plano Pro, com créditos por mensagem.
              Precisa conectar o número oficial? A equipe Tigu acompanha a verificação na Meta (docs/WHATSAPP.md).
            </p>
            <p className="mt-4 text-xs text-zinc-500">Já tem conta? <Link className="font-semibold text-[var(--c-gold)] hover:underline" to="/login">Entrar</Link></p>
          </aside>
        </div>
      </div>
    </div>
  );
}
