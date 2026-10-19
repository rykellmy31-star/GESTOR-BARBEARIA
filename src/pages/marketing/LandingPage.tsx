import { Link } from "react-router-dom";
import { ArrowRight, Bell, CalendarCheck, CreditCard, Lock, ScanFace, Scissors, ShieldCheck, Store, MessageCircle } from "lucide-react";
import { useReveal } from "@/lib/hooks";

const feats = [
  { icon: CalendarCheck, t: "Agenda à prova de conflito", d: "Trava real de horários: dois clientes nunca marcam o mesmo barbeiro no mesmo minuto — em todas as barbearias ao mesmo tempo." },
  { icon: Bell, t: "Lembrete de WhatsApp 1h antes", d: "Disparo automático pelo servidor (cron + fila persistente), no fuso de cada unidade, com cobrança por mensagem aceita." },
  { icon: CreditCard, t: "Carteira de créditos", d: "Recarga por Pix confirmada pelo gateway, livro-razão imutável e saldo jamais negativo por padrão." },
  { icon: Store, t: "Loja com estoque", d: "Produtos com reserva de estoque no pedido e retirada no balcão." },
  { icon: Lock, t: "Isolamento por empresa", d: "Autorização no servidor a cada request; nenhuma barbearia enxerga dados da outra — nem por ID." },
  { icon: ScanFace, t: "LGPD desde o primeiro dia", d: "Consentimento de mensagens, anonimização sob pedido e trilha de auditoria completa." },
];

export function LandingPage() {
  useReveal([]);
  return (
    <div className="texture min-h-screen bg-[#0a0a0c]">
      <header className="mx-auto flex h-16 max-w-6xl items-center px-4 sm:px-6">
        <div className="flex items-center gap-2"><Scissors className="h-6 w-6 text-[var(--c-gold)]" /><span className="font-display text-xl tracking-wide text-zinc-50">tigu</span></div>
        <nav className="ml-auto hidden items-center gap-6 text-sm text-zinc-400 md:flex">
          <a href="#recursos" className="hover:text-[var(--c-gold)]">Recursos</a>
          <a href="#planos" className="hover:text-[var(--c-gold)]">Planos</a>
          <Link to="/preview" className="hover:text-[var(--c-gold)]">Prévia visual</Link>
        </nav>
        <div className="ml-auto flex items-center gap-2 md:ml-6">
          <Link to="/login" className="rounded-xl border border-[#26262f] px-4 py-2 text-sm text-zinc-200 hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]">Entrar</Link>
          <Link to="/comecar" className="btn-gold rounded-xl px-4 py-2 text-sm">Criar barbearia</Link>
        </div>
      </header>

      <section className="mx-auto max-w-6xl px-4 pb-16 pt-14 text-center sm:px-6 md:pt-24">
        <p className="reveal text-[11px] font-bold uppercase tracking-[0.35em] text-[var(--c-gold)]">SaaS de agendamento + WhatsApp para barbearias</p>
        <h1 className="reveal mx-auto mt-4 max-w-3xl font-display text-4xl leading-tight text-zinc-50 sm:text-5xl md:text-6xl">
          Cada barbearia com seu site, sua agenda e o <span className="gold-text">seu</span> WhatsApp.
        </h1>
        <p className="reveal mx-auto mt-5 max-w-2xl text-[15px] leading-relaxed text-zinc-400">
          A Tigu opera a plataforma; a sua barbearia recebe os clientes. Lembrete automático uma hora antes,
          recarga de créditos por Pix, painel da equipe e da loja — tudo isolado por empresa e auditável.
        </p>
        <div className="reveal mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to="/comecar" className="btn-gold inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold">Começar grátis <ArrowRight size={16} /></Link>
          <Link to="/preview" className="inline-flex items-center gap-2 rounded-xl border border-[#26262f] px-6 py-3 text-sm text-zinc-200 hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]">Explorar prévia visual</Link>
        </div>
        <p className="reveal mt-4 text-[11px] text-zinc-500">A prévia visual usa dados fictícios e não realiza cadastro, agendamento, cobrança ou envio de WhatsApp.</p>
      </section>

      <section id="recursos" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {feats.map((f) => (
            <div key={f.t} className="card-luxe reveal rounded-2xl border border-[#26262f] bg-[#16161c] p-5">
              <f.icon size={20} className="text-[var(--c-gold)]" />
              <h3 className="mt-3 font-display text-lg text-zinc-100">{f.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">{f.d}</p>
            </div>
          ))}
        </div>
      </section>

      <section id="planos" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-4 md:grid-cols-3">
          {[
            { n: "Start", p: "R$ 0", d: "Para organizar a agenda on-line", items: ["Site público + agenda", "2 profissionais", "100 mensagens/mês (sem WhatsApp ativado)", "Suporte por e-mail"] },
            { n: "Pro", p: "R$ 49,90", d: "A escolha das barbearias", items: ["Tudo do Start", "6 profissionais", "Lembretes WhatsApp automáticos", "3.000 mensagens/mês", "Loja completa"], gold: true },
            { n: "Scale", p: "R$ 129,90", d: "Rede de unidades", items: ["Profissionais ilimitados", "Mensagens ilimitadas (tarifa por envio)", "Multi-unidade com o mesmo login", "Prioridade de suporte"] },
          ].map((pl) => (
            <div key={pl.n} className={`reveal rounded-2xl border p-6 ${pl.gold ? "border-[var(--c-gold)]/60 bg-[color-mix(in_srgb,var(--c-gold)_6%,#16161c)]" : "border-[#26262f] bg-[#16161c]"}`}>
              <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-zinc-500">{pl.n}</p>
              <p className="mt-2 font-display text-3xl text-zinc-50">{pl.p}<span className="text-sm text-zinc-500">/mês</span></p>
              <p className="mt-1 text-xs text-zinc-500">{pl.d}</p>
              <ul className="mt-4 space-y-2 text-sm text-zinc-300">{pl.items.map((i) => <li key={i} className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--c-gold)]" />{i}</li>)}</ul>
              <Link to="/comecar" className={`${pl.gold ? "btn-gold" : "mt-6 block w-full rounded-xl border border-[#26262f] py-2.5 text-sm text-zinc-200 hover:border-[var(--c-gold)]"} mt-6 flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-semibold`}>Selecionar</Link>
            </div>
          ))}
        </div>
        <p className="mt-4 text-center text-[11px] text-zinc-600">Mensagens de WhatsApp: R$ 0,10 por mensagem aceita no provedor (custo do WhatsApp por conta da barbearia via créditos; política de estorno automático em falha). Valores iniciais ajustáveis pela plataforma.</p>
      </section>

      <section className="mx-auto max-w-6xl px-4 py-16 sm:px-6">
        <div className="reveal flex flex-wrap items-center justify-between gap-6 rounded-2xl border border-[var(--c-gold)]/40 bg-[color-mix(in_srgb,var(--c-gold)_8%,#0a0a0c)] p-8">
          <div>
            <h2 className="font-display text-2xl text-zinc-50">Pronto para tirar a agenda do caderno?</h2>
            <p className="mt-1 text-sm text-zinc-400">Cinco minutos até o seu link: tigu.app/sua-barbearia <span className="text-zinc-600">(demo local usa /c/sua-barbearia)</span></p>
          </div>
          <Link to="/comecar" className="btn-gold inline-flex items-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold">Criar agora <ArrowRight size={16} /></Link>
        </div>
      </section>

      <footer className="border-t border-[#26262f] py-8 text-center text-xs text-zinc-600">
        <p className="flex items-center justify-center gap-1.5"><MessageCircle size={13} className="text-[var(--c-gold)]" /> Integração oficial WhatsApp Business Platform · <Lock size={13} className="text-[var(--c-gold)]" /> dados isolados por empresa</p>
        <p className="mt-2">Tigu — plataforma para barbearias. Feita para o Brasil (BRL, pt-BR, America/Bahia).</p>
      </footer>
    </div>
  );
}
