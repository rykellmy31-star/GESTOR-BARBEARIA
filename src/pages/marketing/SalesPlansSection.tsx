import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { api } from "@/lib/api";

type Code = "free" | "pro" | "scale";
interface SalesPlan {
  code: Code;
  name: string;
  price_cents_month: number;
  max_barbers: number;
  max_messages_month: number;
  whatsapp_enabled: number;
  store_enabled: number;
}

/** Valores de demonstração somente na prévia Pages, quando a API não existe. */
const demo: SalesPlan[] = [
  {code:"free",name:"Tigu Start",price_cents_month:0,max_barbers:2,max_messages_month:100,whatsapp_enabled:0,store_enabled:1},
  {code:"pro",name:"Tigu Pro",price_cents_month:4990,max_barbers:6,max_messages_month:3000,whatsapp_enabled:1,store_enabled:1},
  {code:"scale",name:"Tigu Scale",price_cents_month:12990,max_barbers:-1,max_messages_month:-1,whatsapp_enabled:1,store_enabled:1},
];
const formatPrice = (cents: number) => (cents / 100).toLocaleString("pt-BR", {style:"currency",currency:"BRL"});
const formatLimit = (n:number) => n === -1 ? "Ilimitado" : n.toLocaleString("pt-BR");

export function SalesPlansSection() {
  const q = useQuery({
    queryKey:["public-sales-plans"],
    queryFn:()=>api.get<{plans:SalesPlan[];automatic_billing:boolean}>("/marketing/plans"),
    retry:false,
    staleTime:30_000,
    refetchOnWindowFocus:true,
  });
  const live = q.isSuccess && q.data?.plans?.length === 3;
  const plans = live ? q.data!.plans : demo;

  return (
    <section id="planos" className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
      <div className="mb-6 text-center">
        <h2 className="font-display text-2xl text-zinc-50 sm:text-3xl">Um plano para cada momento</h2>
        <p className="mt-2 text-sm text-zinc-400">Conheça os recursos e comece pela agenda gratuita.</p>
      </div>
      {!live && !q.isLoading && (
        <p role="status" className="mb-4 rounded-xl border border-amber-400/30 bg-amber-400/5 p-3 text-center text-xs text-amber-200">
          Prévia sem API conectada: valores ilustrativos, não constituem proposta de contratação.
        </p>
      )}
      <div className="grid gap-4 md:grid-cols-3">
        {plans.map(plan => {
          const featured = plan.code === "pro";
          const benefits = [
            "Site público de agendamentos",
            plan.max_barbers === -1 ? "Profissionais ilimitados" : `${formatLimit(plan.max_barbers)} profissionais`,
            plan.whatsapp_enabled ? "WhatsApp habilitado mediante conexão do número" : "WhatsApp automático não incluído",
            plan.whatsapp_enabled
              ? `Limite de mensagens: ${formatLimit(plan.max_messages_month)}/mês (créditos por envio)`
              : "Sem envios automáticos de WhatsApp",
            plan.store_enabled ? "Loja de produtos com estoque" : "Sem módulo de loja",
          ];
          return (
            <article key={plan.code}
              className={`reveal rounded-2xl border p-6 ${featured ? "border-[var(--c-gold)]/60 bg-[color-mix(in_srgb,var(--c-gold)_6%,#16161c)]" : "border-[#26262f] bg-[#16161c]"}`}>
              <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-zinc-500">{plan.name}</p>
              <p className="mt-2 font-display text-3xl text-zinc-50">
                {formatPrice(plan.price_cents_month)} <span className="text-sm text-zinc-500">/mês</span>
              </p>
              <p className="mt-1 text-xs text-zinc-400">
                {plan.code === "free" ? "Para começar a receber agendamentos" :
                plan.code === "pro" ? "Para equipes que precisam de lembretes" :
                "Para redes e operações maiores"}
              </p>
              <ul className="mt-5 space-y-2 text-sm text-zinc-300">
                {benefits.map(b => <li key={b} className="flex gap-2">
                  <ShieldCheck size={14} className="mt-0.5 shrink-0 text-[var(--c-gold)]" /> {b}
                </li>)}
              </ul>
              <Link to="/comecar" className={`${featured ? "btn-gold" : "border border-[#35313b] text-zinc-200 hover:border-[var(--c-gold)]"} mt-6 flex w-full items-center justify-center rounded-xl px-4 py-3 text-sm font-semibold`}>
                {plan.code === "free" ? "Criar conta grátis" : "Começar grátis e consultar upgrade"}
              </Link>
              {plan.code !== "free" && (
                <p className="mt-2 text-center text-[11px] leading-relaxed text-zinc-500">
                  Planos pagos são ativados pela equipe Tigu. O cadastro inicial não contrata nem cobra este plano.
                </p>
              )}
            </article>
          );
        })}
      </div>
      <p className="mt-4 text-center text-xs leading-relaxed text-zinc-500">
        Valores de mensalidade não incluem créditos para mensagens. Contratação e cobrança recorrente dos planos pagos ainda dependem de ativação assistida.
      </p>
    </section>
  );
}
