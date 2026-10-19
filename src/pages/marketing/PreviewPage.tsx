import { useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  Activity, ArrowLeft, ArrowUpRight, CalendarDays, CheckCircle2, ChevronRight, Mail,
  Clock3, CreditCard, LayoutDashboard, MessageCircle, Scissors, ShieldCheck,
  ShoppingBag, Store, Users, Wallet, AlertTriangle, type LucideIcon
} from "lucide-react";

type View = "platform" | "vendas" | "pagamento" | "mensalidades" | "interessados" | "barbearia" | "agenda" | "mensagens" | "carteira" | "loja";
type NavItem = { key: View; title: string; subtitle: string; icon: LucideIcon };

const navigation: NavItem[] = [
  { key: "platform", title: "Superadmin Tigu", subtitle: "Visão da plataforma", icon: ShieldCheck },
  { key: "vendas", title: "Página de vendas", subtitle: "Contratação e contato", icon: MessageCircle },
  { key: "pagamento", title: "Pagamento Pix", subtitle: "Pós-teste de 15 dias", icon: CreditCard },
  { key: "mensalidades", title: "Mensalidades Pix", subtitle: "Gestão do Superadmin", icon: CreditCard },
  { key: "interessados", title: "Interessados", subtitle: "Pedidos de contratação", icon: Users },
  { key: "barbearia", title: "Painel da barbearia", subtitle: "Indicadores e equipe", icon: LayoutDashboard },
  { key: "agenda", title: "Agenda", subtitle: "Próximos horários", icon: CalendarDays },
  { key: "mensagens", title: "WhatsApp", subtitle: "Lembretes e envios", icon: MessageCircle },
  { key: "carteira", title: "Carteira", subtitle: "Saldo e créditos", icon: Wallet },
  { key: "loja", title: "Loja", subtitle: "Produtos e estoque", icon: ShoppingBag },
];

const appointments = [
  { time: "09:00", name: "Lucas Almeida", service: "Corte degradê", barber: "João", status: "Confirmado" },
  { time: "10:30", name: "Pedro Martins", service: "Corte + barba", barber: "Rafael", status: "Confirmado" },
  { time: "11:00", name: "Matheus Costa", service: "Barba premium", barber: "João", status: "Pendente" },
  { time: "14:30", name: "André Ribeiro", service: "Corte social", barber: "Marcos", status: "Confirmado" },
];

const messageRows = [
  { name: "Lucas Almeida", kind: "Lembrete de horário", date: "Hoje, 08:00", status: "Entregue" },
  { name: "Pedro Martins", kind: "Confirmação de reserva", date: "Hoje, 09:12", status: "Enviado" },
  { name: "Matheus Costa", kind: "Lembrete de horário", date: "Hoje, 10:00", status: "Agendado" },
];

function Tag({ children, tone = "neutral" }: { children: React.ReactNode; tone?: "green" | "gold" | "neutral" }) {
  const colors = tone === "green"
    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-300"
    : tone === "gold"
      ? "border-amber-400/30 bg-amber-400/10 text-amber-200"
      : "border-white/10 bg-white/5 text-zinc-300";
  return <span className={"inline-flex items-center rounded-full border px-2.5 py-1 text-[11px] font-medium " + colors}>{children}</span>;
}

function Panel({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-[#2d2d35] bg-[#16161c] p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-display text-lg text-zinc-100">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Metric({ label, value, caption, icon: Icon }: { label: string; value: string; caption: string; icon: LucideIcon }) {
  return (
    <div className="rounded-2xl border border-[#2d2d35] bg-[#16161c] p-4 sm:p-5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-zinc-400">{label}</span>
        <Icon size={17} className="text-[#d4af37]" aria-hidden="true" />
      </div>
      <p className="mt-3 font-display text-2xl text-zinc-50 sm:text-3xl">{value}</p>
      <p className="mt-1.5 text-[11px] text-zinc-500">{caption}</p>
    </div>
  );
}

function ScheduleTable({ barber = "Todos" }: { barber?: string }) {
  const rows = barber === "Todos" ? appointments : appointments.filter((item) => item.barber === barber);
  return (
    <>
      {/* A lista em cartões evita arrastar tabelas horizontalmente no celular. */}
      <div className="space-y-2 md:hidden">
        {rows.map((item) => (
          <div key={item.time} className="rounded-xl border border-[#303039] bg-[#111115] p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <span className="font-display text-lg text-[#e8ca66]">{item.time}</span>
              <Tag tone={item.status === "Confirmado" ? "green" : "gold"}>{item.status}</Tag>
            </div>
            <p className="text-sm font-semibold text-zinc-100">{item.name}</p>
            <p className="mt-1 text-xs text-zinc-400">{item.service}</p>
            <p className="mt-1 text-xs text-zinc-500">Profissional: {item.barber}</p>
          </div>
        ))}
      </div>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-[#303039] text-xs text-zinc-500">
            <tr><th className="pb-3 font-medium">Horário</th><th className="pb-3 font-medium">Cliente</th><th className="pb-3 font-medium">Serviço</th><th className="pb-3 font-medium">Profissional</th><th className="pb-3 text-right font-medium">Situação</th></tr>
          </thead>
          <tbody className="divide-y divide-[#292931]">
            {rows.map(item => (
              <tr key={item.time}>
                <td className="py-3 font-semibold text-[#e8ca66]">{item.time}</td>
                <td className="py-3 text-zinc-200">{item.name}</td>
                <td className="py-3 text-zinc-400">{item.service}</td>
                <td className="py-3 text-zinc-400">{item.barber}</td>
                <td className="py-3 text-right"><Tag tone={item.status === "Confirmado" ? "green" : "gold"}>{item.status}</Tag></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && <p className="py-6 text-center text-xs text-zinc-500">Nenhum atendimento neste filtro.</p>}
    </>
  );
}

function ScheduleFilters() {
  const [barber, setBarber] = useState("Todos");
  const barbers = ["Todos", ...Array.from(new Set(appointments.map((a) => a.barber)))];
  return (
    <div>
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Filtrar agendamentos por barbeiro">
        {barbers.map((name) => (
          <button key={name} type="button" onClick={() => setBarber(name)}
            aria-pressed={barber === name}
            className={"rounded-lg border px-3 py-2 text-xs font-medium transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d4af37] " +
              (barber === name
                ? "border-[#d4af37]/60 bg-[#d4af37]/10 text-[#e8ca66]"
                : "border-[#303039] text-zinc-400 hover:border-[#d4af37]/50 hover:text-zinc-100")}>
            {name}
          </button>
        ))}
      </div>
      <ScheduleTable barber={barber} />
    </div>
  );
}

function PreviewSection({ view, onNavigate }: { view: View; onNavigate: (v: View) => void }) {
  if (view === "platform") return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric label="Barbearias ativas" value="12" caption="3 novas neste mês" icon={Store} />
        <Metric label="Mensagens enviadas" value="2.480" caption="Somente números fictícios" icon={MessageCircle} />
        <Metric label="Créditos utilizados" value="R$ 248" caption="Exemplo, sem cobrança real" icon={CreditCard} />
        <Metric label="Agendamentos" value="863" caption="Últimos 30 dias (exemplo)" icon={CalendarDays} />
      </div>
      <div className="grid gap-5 xl:grid-cols-[1.6fr_1fr]">
        <Panel title="Barbearias na plataforma" aside={<Tag>3 unidades exibidas</Tag>}>
          <div className="space-y-2">
            {[
              ["Barbearia Estilo Premium", "Pro", "42 agendamentos"],
              ["Barbearia Central", "Scale", "67 agendamentos"],
              ["Studio Navalha", "Start", "18 agendamentos"],
            ].map(([name, plan, bookings]) => (
              <div key={name} className="flex flex-wrap items-center justify-between gap-3 rounded-xl bg-[#101014] p-3">
                <div className="flex items-center gap-3"><div className="grid h-10 w-10 place-items-center rounded-xl bg-[#d4af37]/10"><Scissors size={18} className="text-[#d4af37]" /></div>
                  <div><p className="text-sm font-medium text-zinc-100">{name}</p><p className="text-xs text-zinc-500">{bookings}</p></div>
                </div>
                <Tag tone={plan === "Scale" ? "gold" : "green"}>{plan}</Tag>
              </div>
            ))}
          </div>
        </Panel>
        <Panel title="Atalhos para conferir">
          <div className="space-y-2">
            {([
              ["Ver painel da barbearia", "barbearia"],
              ["Conferir agendamentos", "agenda"],
              ["Inspecionar créditos", "carteira"],
              ["Ver automações", "mensagens"],
              ["Ver contato de vendas", "vendas"],
              ["Ver pedidos de contratação", "interessados"],
              ["Conferir mensalidades Pix", "mensalidades"],
            ] as const).map(([name, key]) => (
              <button key={key} type="button" onClick={() => onNavigate(key)}
                className="flex w-full items-center justify-between rounded-xl border border-[#303039] px-3 py-3 text-left text-sm text-zinc-300 transition hover:border-[#d4af37]/60 hover:text-[#d4af37]">
                {name}<ChevronRight size={15} />
              </button>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );

  if (view === "pagamento") return (
    <div className="space-y-5">
      <Panel title="Fim dos 15 dias de teste grátis" aside={<Tag tone="gold">Demonstração, sem pagamento real</Tag>}>
        <div className="mx-auto max-w-lg rounded-2xl border border-[#d4af37]/40 bg-[#111115] p-6 text-center sm:p-8">
          <Clock3 size={32} className="mx-auto text-[#e8ca66]" />
          <h3 className="mt-3 font-display text-2xl text-zinc-50">Seu teste grátis terminou!</h3>
          <p className="mt-2 text-sm leading-relaxed text-zinc-400">
            Para continuar gerenciando sua barbearia, renove sua assinatura pelo Pix.
            Seus dados permanecem salvos.
          </p>
          <p className="mt-5 text-xs uppercase tracking-wider text-[#e8ca66]">Tigu Start</p>
          <p className="mt-1 font-display text-3xl text-zinc-50">R$ 19,99 <span className="text-sm text-zinc-500">/mês</span></p>
          <button type="button" disabled
            className="mt-5 w-full cursor-not-allowed rounded-xl bg-[#d4af37] px-4 py-3 text-sm font-semibold text-[#111115] opacity-70">
            Gerar Pix de R$ 19,99 (simulação)
          </button>
          <p className="mt-3 text-xs leading-relaxed text-zinc-500">No sistema funcional, o botão gerará o QR Code e o Pix Copia e Cola pelo Mercado Pago. O acesso só será liberado depois que o pagamento for confirmado na API.</p>
        </div>
      </Panel>
      <Panel title="Etapas da renovação" aside={<Tag tone="gold">Exemplo visual</Tag>}>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["1", "Gerar Pix", "Valor do plano no banco"],
            ["2", "Pagar no banco", "QR Code ou Copia e Cola"],
            ["3", "Acesso liberado", "Somente após confirmação no Mercado Pago"],
          ].map(([n,name,desc])=>(
            <div key={n} className="rounded-xl border border-[#35313b] bg-[#111115] p-4">
              <span className="font-display text-lg text-[#e8ca66]">{n}.</span>
              <p className="mt-1 text-sm font-semibold text-zinc-100">{name}</p>
              <p className="mt-1 text-xs text-zinc-400">{desc}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-zinc-500">Pix mensal por iniciativa do cliente: sem débito automático e sem dados bancários fictícios.</p>
      </Panel>
    </div>
  );

  if (view === "vendas") return (
    <div className="space-y-5">
      <Panel title="Planos na página de vendas" aside={<Tag tone="gold">Exemplo, não é contratação</Tag>}>
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["Start", "R$ 19,99", "Teste grátis por 15 dias, depois mensalidade"],
            ["Pro", "R$ 49,90", "Lembretes e equipe"],
            ["Scale", "R$ 129,90", "Operações maiores"],
          ].map(([name, price, benefit]) => (
            <div key={name} className="rounded-xl border border-[#39323a] bg-[#101014] p-4">
              <p className="text-xs font-medium text-[#e8ca66]">{name}</p>
              <p className="mt-2 font-display text-2xl text-zinc-50">{price}<span className="text-xs text-zinc-500">/mês</span></p>
              {name === "Start" && <span className="mt-2 inline-block rounded-full border border-[#d4af37]/50 bg-[#d4af37]/10 px-3 py-1 text-[11px] font-medium text-[#e8ca66]">Teste grátis por 15 dias</span>}
              <p className="mt-2 text-xs text-zinc-400">{benefit}</p>
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-zinc-500">Valores da demonstração: Start R$ 19,99/mês após 15 dias de teste grátis. O Superadmin pode alterar os preços no sistema funcional. Nenhum plano é cobrado automaticamente.</p>
      </Panel>
      <Panel title="Após os 15 dias: escolha seu plano" aside={<Tag tone="gold">Exemplo visual</Tag>}>
        <div className="rounded-xl border border-amber-400/25 bg-amber-400/5 px-4 py-3 text-sm text-zinc-200">
          <p className="font-semibold text-[#e8ca66]">Seu teste grátis terminou!</p>
          <p className="mt-1 text-xs text-zinc-400">Escolha como deseja continuar. Nenhum dado da barbearia será apagado.</p>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          {[
            ["Start","R$ 19,99","Até 2 profissionais"],
            ["Pro","R$ 49,90","Até 6 profissionais"],
            ["Scale","R$ 129,90","Profissionais ilimitados"],
          ].map(([name,price,detail])=>(
            <div key={name} className={`rounded-xl border p-4 ${name==="Pro"?"border-[#d4af37] bg-[#d4af37]/10":"border-[#39323a] bg-[#101014]"}`}>
              <p className="text-sm font-semibold text-zinc-100">{name}</p>
              <p className="mt-2 text-xl font-semibold text-[#e8ca66]">{price}<span className="text-xs text-zinc-400">/mês</span></p>
              <p className="mt-2 text-xs text-zinc-400">{detail}</p>
              <p className="mt-3 text-[11px] text-zinc-500">{name==="Pro"?"Plano de exemplo selecionado":"Outra opção disponível"}</p>
            </div>
          ))}
        </div>
        <button type="button" disabled className="mt-4 w-full cursor-not-allowed rounded-xl bg-[#d4af37]/70 px-5 py-3 text-sm font-semibold text-[#16120b] opacity-80">
          Gerar Pix do plano escolhido (simulação)
        </button>
        <p className="mt-2 text-xs leading-relaxed text-zinc-500">No sistema funcional, o cliente poderá trocar para um plano superior durante a assinatura. A mudança só acontece após a confirmação do Pix pelo Mercado Pago, com os dias atuais preservados. Botão desativado neste preview.</p>
      </Panel>
      <Panel title="Como o visitante encontrará seu contato" aside={<Tag tone="gold">Demonstração visual</Tag>}>
        <div className="rounded-2xl border border-[#d4af37]/40 bg-[#111115] p-6 text-center sm:p-10">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-[#d4af37]">Atendimento comercial</p>
          <h3 className="mx-auto mt-3 max-w-xl font-display text-2xl text-zinc-50 sm:text-3xl">
            Ficou alguma dúvida antes de contratar?
          </h3>
          <p className="mx-auto mt-3 max-w-lg text-sm leading-relaxed text-zinc-400">
            O interessado poderá conversar com você sobre planos, recursos e contratação antes de criar a barbearia.
          </p>
          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <button type="button" disabled className="inline-flex cursor-not-allowed items-center gap-2 rounded-xl bg-[#d4af37]/70 px-5 py-3 text-sm font-semibold text-[#16120b] opacity-80">
              <MessageCircle size={17} /> Tirar dúvidas no WhatsApp
            </button>
            <button type="button" disabled className="inline-flex cursor-not-allowed items-center gap-2 rounded-xl border border-[#303039] px-5 py-3 text-sm text-zinc-300 opacity-70">
              <Mail size={17} /> Falar por e-mail
            </button>
          </div>
        </div>
      </Panel>
      <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs leading-relaxed text-amber-100">
        Os botões acima são apenas ilustrativos e não enviam mensagens.
        Você cadastrará seu número e e-mail em Superadmin → Config. plataforma → Contato da página de vendas.
        Quando o backend estiver conectado, as informações salvas aparecerão automaticamente na página inicial de contratação.
      </div>
    </div>
  );

  if (view === "mensalidades") return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric label="Mensalidades pagas" value="R$ 179,79" caption="Valor fictício" icon={CreditCard} />
        <Metric label="Pix confirmados" value="3" caption="Exemplos simulados" icon={CheckCircle2} />
        <Metric label="Aguardando Pix" value="2" caption="Exemplos de cobrança" icon={Clock3} />
        <Metric label="Em conferência" value="1" caption="Exige consulta ao gateway" icon={AlertTriangle} />
      </div>
      <Panel title="Mensalidades Pix das barbearias" aside={<Tag tone="gold">Dados fictícios</Tag>}>
        <div className="space-y-3">
          {[
            ["Barbearia Modelo", "Start", "R$ 19,99", "Pago / confirmado"],
            ["Studio Fictício", "Pro", "R$ 49,90", "Aguardando Pix"],
            ["Barbearia Teste", "Scale", "R$ 129,90", "Em criação"],
          ].map(([company,plan,price,status]) => (
            <div key={company} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#303039] bg-[#111115] p-4">
              <div>
                <p className="text-sm font-medium text-zinc-100">{company}</p>
                <p className="mt-1 text-xs text-zinc-500">Plano {plan} · Mensalidade {price}</p>
              </div>
              <Tag tone={status === "Pago / confirmado" ? "green" : "gold"}>{status}</Tag>
            </div>
          ))}
        </div>
      </Panel>
      <div className="flex items-start gap-2 rounded-xl border border-[#39323a] bg-[#111115] p-4 text-xs leading-relaxed text-zinc-400">
        <ShieldCheck size={16} className="shrink-0 text-[#d4af37]"/>
        Na área funcional do Superadmin, as faturas reais poderão ser filtradas por situação e barbearia. A consulta não permite aprovar pagamentos manualmente.
        Somente a confirmação pelo Mercado Pago libera a assinatura. Esta tela é uma simulação visual, sem dados financeiros reais.
      </div>
    </div>
  );

  if (view === "interessados") return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
        <Metric label="Novas solicitações" value="4" caption="Dados fictícios de demonstração" icon={Users} />
        <Metric label="Em negociação" value="2" caption="Sem cobrança ou ativação" icon={MessageCircle} />
        <Metric label="Atendimentos encerrados" value="3" caption="Simulação do funil comercial" icon={CheckCircle2} />
      </div>
      <Panel title="Privacidade dos contatos" aside={<Tag tone="gold">Simulação visual</Tag>}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-zinc-100">Prazo de retenção: 180 dias</p>
            <p className="mt-1 text-xs text-zinc-400">O Superadmin poderá escolher 30, 90, 180 ou 365 dias e excluir contatos quando necessário.</p>
          </div>
          <span className="rounded-xl border border-[#39323a] px-4 py-2 text-xs text-zinc-400">Contatos fictícios — nenhum dado é excluído aqui</span>
        </div>
        <p className="mt-3 text-[11px] leading-relaxed text-zinc-500">Esta seção ilustra os controles de privacidade. No sistema funcional, alterações e exclusões exigem autenticação de Superadmin.</p>
      </Panel>
      <Panel title="Interessados nos planos" aside={<Tag tone="gold">Exemplo, sem clientes reais</Tag>}>
        <div className="space-y-3">
          {[
            ["Barbearia Modelo", "Ana Exemplo", "Pro", "Novo"],
            ["Studio Fictício", "Bruno Demonstração", "Scale", "Contato realizado"],
            ["Barbearia Teste", "Carlos Simulação", "Pro", "Em negociação"],
          ].map(([company, contact, plan, status]) => (
            <div key={company} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#303039] bg-[#111115] p-4">
              <div>
                <p className="text-sm font-semibold text-zinc-100">{company}</p>
                <p className="mt-1 text-xs text-zinc-400">{contact} · Plano {plan}</p>
              </div>
              <Tag tone={status === "Novo" ? "gold" : "green"}>{status}</Tag>
            </div>
          ))}
        </div>
        <p className="mt-4 text-xs leading-relaxed text-zinc-500">No Superadmin funcional, você poderá visualizar os contatos enviados com consentimento, registrar observações e atualizar o andamento. Nenhum desses registros é real.</p>
      </Panel>
    </div>
  );

  if (view === "barbearia") return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Metric label="Agendamentos hoje" value="18" caption="15 confirmados, 3 pendentes" icon={CalendarDays} />
        <Metric label="Faturamento do dia" value="R$ 940" caption="Exemplo fictício de atendimentos" icon={CreditCard} />
        <Metric label="Profissionais ativos" value="4" caption="2 com atendimento agora" icon={Users} />
        <Metric label="Clientes cadastrados" value="286" caption="Dados de demonstração" icon={Activity} />
      </div>
      <Panel title="Agenda do dia" aside={<button className="text-xs text-[#d4af37] hover:underline" onClick={() => onNavigate("agenda")}>Abrir agenda →</button>}>
        <ScheduleTable />
      </Panel>
      <div className="grid gap-5 md:grid-cols-2">
        <Panel title="Serviços mais procurados">
          {[
            ["Corte degradê", 75], ["Corte + barba", 58], ["Barba premium", 38]
          ].map(([name, n]) => (
            <div className="mb-3 last:mb-0" key={name}>
              <div className="mb-1 flex justify-between text-xs text-zinc-300"><span>{name}</span><span>{n}%</span></div>
              <div className="h-2 rounded-full bg-[#2b2b32]"><div className="h-2 rounded-full bg-[#d4af37]" style={{ width: n + "%" }} /></div>
            </div>
          ))}
        </Panel>
        <Panel title="Atividade recente">
          <div className="space-y-3 text-xs text-zinc-300">
            <p className="flex items-center gap-2"><CheckCircle2 size={15} className="text-emerald-400" /> Reserva confirmada para 14:30</p>
            <p className="flex items-center gap-2"><MessageCircle size={15} className="text-[#d4af37]" /> Lembrete automático programado</p>
            <p className="flex items-center gap-2"><ShoppingBag size={15} className="text-blue-300" /> Novo pedido de produto</p>
          </div>
        </Panel>
      </div>
    </div>
  );

  if (view === "agenda") return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Metric label="Horários ocupados" value="18" caption="Exemplo do dia" icon={Clock3} />
        <Metric label="Confirmações" value="15" caption="83% da agenda de hoje" icon={CheckCircle2} />
        <Metric label="Equipe de plantão" value="4" caption="João, Rafael, Marcos e Caio" icon={Scissors} />
      </div>
      <Panel title="Atendimentos de hoje" aside={<Tag tone="gold">Horários fictícios</Tag>}><ScheduleFilters /></Panel>
    </div>
  );

  if (view === "mensagens") return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Metric label="Lembretes programados" value="9" caption="Sem envio real nesta prévia" icon={Clock3} />
        <Metric label="Mensagens entregues" value="64" caption="Quantidade simulada" icon={MessageCircle} />
        <Metric label="Créditos reservados" value="R$ 0,90" caption="Apenas apresentação visual" icon={Wallet} />
      </div>
      <Panel title="Fila de WhatsApp" aside={<Tag>Somente demonstração</Tag>}>
        <div className="space-y-2">
          {messageRows.map(m => (
            <div key={m.name} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#303039] p-3">
              <div><p className="text-sm font-medium text-zinc-100">{m.name}</p><p className="text-xs text-zinc-500">{m.kind} · {m.date}</p></div>
              <Tag tone={m.status === "Entregue" ? "green" : "gold"}>{m.status}</Tag>
            </div>
          ))}
        </div>
      </Panel>
      <p className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 p-4 text-xs text-amber-200">
        <AlertTriangle size={16} className="shrink-0" /> Nenhuma mensagem é enviada nesta prévia. A integração real depende do Worker e da conexão de cada barbearia.
      </p>
    </div>
  );

  if (view === "carteira") return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Metric label="Saldo total" value="R$ 75,00" caption="Saldo fictício da barbearia" icon={Wallet} />
        <Metric label="Saldo reservado" value="R$ 0,90" caption="Mensagens a processar" icon={Clock3} />
        <Metric label="Disponível" value="R$ 74,10" caption="Nenhuma transação real" icon={CreditCard} />
      </div>
      <Panel title="Extrato ilustrativo" aside={<Tag tone="gold">Pix desativado na prévia</Tag>}>
        <div className="divide-y divide-[#303039]">
          {[
            ["Recarga de créditos", "Hoje · 08:30", "+ R$ 50,00", "text-emerald-300"],
            ["Mensagem de confirmação", "Hoje · 09:12", "− R$ 0,10", "text-zinc-200"],
            ["Lembrete entregue", "Ontem · 17:10", "− R$ 0,10", "text-zinc-200"],
          ].map(([name, date, amount, color]) => (
            <div key={name} className="flex items-center justify-between gap-3 py-3 text-sm">
              <div><p className="text-zinc-100">{name}</p><p className="text-xs text-zinc-500">{date}</p></div>
              <span className={"font-medium " + color}>{amount}</span>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
        <Metric label="Produtos cadastrados" value="24" caption="Catálogo de demonstração" icon={ShoppingBag} />
        <Metric label="Pedidos no dia" value="7" caption="Sem compras reais" icon={Store} />
        <Metric label="Estoque baixo" value="2" caption="Avisos ilustrativos" icon={AlertTriangle} />
      </div>
      <Panel title="Catálogo de produtos">
        <div className="grid gap-3 sm:grid-cols-3">
          {[
            ["Pomada modeladora", "R$ 34,90", "21 unidades"],
            ["Óleo para barba", "R$ 28,00", "14 unidades"],
            ["Shampoo profissional", "R$ 42,00", "4 unidades"],
          ].map(([name, price, stock]) => (
            <div key={name} className="rounded-xl border border-[#303039] bg-[#111115] p-4">
              <div className="mb-3 grid h-20 place-items-center rounded-xl bg-[#262329]"><ShoppingBag size={28} className="text-[#d4af37]" /></div>
              <p className="text-sm font-semibold text-zinc-100">{name}</p>
              <p className="mt-1 font-display text-xl text-[#d4af37]">{price}</p>
              <p className="mt-1 text-xs text-zinc-500">{stock} em estoque</p>
            </div>
          ))}
        </div>
      </Panel>
    </div>
  );
}

export function PreviewPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedView = searchParams.get("tela");
  const view: View = navigation.some((item) => item.key === requestedView)
    ? requestedView as View
    : "platform";
  const current = navigation.find(item => item.key === view)!;
  const setView = (next: View) => {
    setSearchParams((previous) => {
      const updated = new URLSearchParams(previous);
      if (next === "platform") updated.delete("tela");
      else updated.set("tela", next);
      return updated;
    });
  };
  return (
    <div className="texture min-h-screen bg-[#0a0a0c] text-zinc-100">
      <header className="border-b border-[#303039] bg-[#101014]/95">
        <div className="mx-auto flex max-w-[1480px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6">
          <Link to="/" className="flex items-center gap-2 font-display text-xl text-white" aria-label="Voltar à página inicial do Tigu">
            <Scissors size={22} className="text-[#d4af37]" />tigu <span className="ml-1 rounded-md border border-[#d4af37]/30 px-2 py-1 font-sans text-[10px] uppercase tracking-wide text-[#d4af37]">prévia visual</span>
          </Link>
          <Link to="/" className="flex items-center gap-2 text-xs text-zinc-400 hover:text-[#d4af37]"><ArrowLeft size={14} /> Voltar ao site</Link>
        </div>
      </header>
      <div className="mx-auto flex max-w-[1480px] flex-col lg:min-h-[calc(100vh-69px)] lg:flex-row">
        <aside className="border-b border-[#303039] bg-[#101014]/70 px-4 py-5 sm:px-6 lg:w-64 lg:shrink-0 lg:border-b-0 lg:border-r">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.24em] text-zinc-500">Explorar as telas</p>
          <nav className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-1" aria-label="Telas de demonstração do Tigu">
            {navigation.map(({ key, title, subtitle, icon: Icon }) => (
              <button key={key} type="button" onClick={() => setView(key)}
                aria-current={view === key ? "page" : undefined}
                className={"flex items-center gap-3 rounded-xl px-3 py-3 text-left transition focus-visible:outline focus-visible:outline-2 focus-visible:outline-[#d4af37] " +
                  (view === key ? "border border-[#d4af37]/30 bg-[#d4af37]/10 text-[#e8ca66]" : "border border-transparent text-zinc-400 hover:bg-white/5 hover:text-zinc-100")}>
                <Icon size={17} className="shrink-0" />
                <span><span className="block text-xs font-semibold sm:text-sm">{title}</span><span className="hidden text-[11px] opacity-60 sm:block">{subtitle}</span></span>
              </button>
            ))}
          </nav>
          <p className="mt-6 hidden text-xs leading-relaxed text-zinc-500 lg:block">Aqui você avalia os layouts. Nenhum cadastro, mensagem ou pagamento é criado.</p>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-9 lg:py-8">
          <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.2em] text-[#d4af37]">Ambiente de demonstração visual</p>
              <h1 className="font-display text-2xl text-zinc-50 sm:text-3xl">{current.title}</h1>
              <p className="mt-1 text-xs text-zinc-500">Dados fictícios • visualização sem login • nenhuma conexão com clientes reais</p>
            </div>
            <Tag tone="gold"><CheckCircle2 size={12} className="mr-1" /> Somente leitura</Tag>
          </div>
          <PreviewSection view={view} onNavigate={setView} />
          <div className="mt-8 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#303039] bg-[#141419] px-4 py-3 text-xs text-zinc-400">
            <span>Prévia de interface do Tigu. Para testar funções reais, será necessário configurar o Worker e o banco de homologação.</span>
            <span className="inline-flex items-center gap-1 text-[#d4af37]">Tigu em desenvolvimento <ArrowUpRight size={13} /></span>
          </div>
        </main>
      </div>
    </div>
  );
}
