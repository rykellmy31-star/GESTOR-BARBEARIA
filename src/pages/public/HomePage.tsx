import { useState } from "react";
import { Link } from "react-router-dom";
import { Clock, MapPin, Star, Scissors, ShoppingBag, Trash2, Minus, Plus, MessageCircle, BadgeCheck, Send } from "lucide-react";
import { clsx } from "clsx";
import { siteBase, api } from "@/lib/api";
import { MAX_CART_LINES, MAX_CART_QTY, readCart, writeCart } from "@/lib/cart";
import { useConfig, useReveal } from "@/lib/hooks";
import { Badge, Button, EmptyState, Modal, SectionTitle, Spinner, useToast } from "@/components/ui";
import { money, maskPhone } from "@/lib/format";
import type { Barber, Product, Service } from "@/lib/types";
import { CartDrawer } from "./CartDrawer";

export function HomePage() {
  const { data: cfg } = useConfig();
  const s = cfg?.settings;
  // Dados do catálogo chegam depois do layout: reobserve os novos cards
  // para não ficarem ocultos pela animação .reveal enquanto já foram salvos.
  useReveal([cfg, services, barbers, products]);
  const { data: services } = useQuerySafe<Service[]>("services");
  const { data: barbers } = useQuerySafe<Barber[]>("barbers");
  const { data: reviews } = useQuerySafe<any[]>("reviews");
  const { data: products } = useQuerySafe<Product[]>("products");
  const [cartOpen, setCartOpen] = useState(false);
  const shopEnabled = s?.products_enabled !== false;

  return (
    <>
      {/* ── HERO ─────────────────────────────────────────────────────── */}
      <section className="relative flex min-h-[102svh] items-end overflow-hidden">
        <div className="absolute inset-0">
          {s?.banner_url && <img src={s.banner_url} alt="" className="h-full w-full object-cover object-center" loading="eager" />}
          <div className="absolute inset-0 bg-gradient-to-t from-[var(--c-ink)] via-[var(--c-ink)]/55 to-black/40" />
          <div className="absolute inset-0 bg-gradient-to-r from-black/60 via-transparent to-transparent" />
        </div>
        <div className="relative mx-auto w-full max-w-6xl px-4 pb-24 pt-40 sm:px-6">
          <div className="max-w-2xl">
            <p className="animate-fade-up mb-4 inline-flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--c-gold)_40%,transparent)] bg-black/40 px-3.5 py-1.5 text-[11px] font-bold uppercase tracking-[0.28em] text-[var(--c-gold)] backdrop-blur">
              <BadgeCheck size={13} /> {s?.tagline || s?.shop_name}
            </p>
            <h1 className="animate-fade-up font-display text-[42px] leading-[1.04] text-white sm:text-6xl lg:text-7xl" style={{ animationDelay: "0.08s" }}>
              <span className="gold-text">{s?.shop_name}</span>
            </h1>
            <p className="animate-fade-up mt-5 max-w-lg text-[15px] leading-relaxed text-zinc-300 sm:text-lg" style={{ animationDelay: "0.16s" }}>
              {s?.about || "Escolha seu serviço, profissional e horário para fazer seu agendamento."}
            </p>
            <div className="animate-fade-up mt-8 flex flex-wrap items-center gap-3" style={{ animationDelay: "0.24s" }}>
              <Link to="agendar" className="btn-gold inline-flex items-center gap-2 rounded-xl px-7 py-4 text-base" style={{ animationDelay: "0.2s" }}>
                <Scissors size={18} /> Agendar meu horário
              </Link>
              <a href="#servicos" className="btn-ghost inline-flex items-center gap-2 rounded-xl border px-6 py-4 text-[15px] text-zinc-100">Ver serviços e preços</a>
            </div>
            {s?.opening_hours && (
              <p className="mt-6 flex flex-wrap items-center gap-x-5 gap-y-1 text-[13px] text-zinc-400">
                <span className="inline-flex items-center gap-1.5"><Clock size={14} className="text-[var(--c-gold)]" />Confira nossos horários de atendimento</span>
                <span className="inline-flex items-center gap-1.5"><MapPin size={14} className="text-[var(--c-gold)]" />{s.address}</span>
              </p>
            )}
          </div>
        </div>
      </section>

      {/* ── SERVIÇOS ─────────────────────────────────────────────────── */}
      <section id="servicos" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <SectionTitle kicker="Catálogo" title="Serviços & Preços" subtitle="Todos os valores e durações são reais e administrados pela barbearia." />
        {!services ? (
          <Spinner />
        ) : (
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {services.map((sv) => (
              <article key={sv.id} className="card-luxe reveal group flex flex-col overflow-hidden rounded-2xl border border-line bg-panel">
                <div className="relative h-44 overflow-hidden">
                  <img src={sv.photo} alt={sv.name} loading="lazy" className="h-full w-full object-cover transition-transform duration-700 group-hover:scale-[1.06]" />
                  <div className="absolute inset-0 bg-gradient-to-t from-panel via-transparent" />
                  <div className="absolute right-3 top-3"><Badge tone="gold">{sv.category}</Badge></div>
                </div>
                <div className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="font-display text-xl font-semibold text-zinc-50">{sv.name}</h3>
                    <p className="whitespace-nowrap font-display text-xl font-semibold text-[var(--c-gold)]">{money(sv.price_cents)}</p>
                  </div>
                  <p className="mt-2 flex-1 text-[13.5px] leading-relaxed text-zinc-400">{sv.description}</p>
                  <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
                    <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500"><Clock size={13} /> {sv.duration_min} min</span>
                    <Link to={`${siteBase()}/agendar?servico=${sv.id}`} className="btn-gold rounded-lg px-3.5 py-1.5 text-[13px]">Agendar</Link>
                  </div>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>

      {/* ── BARBEIROS ────────────────────────────────────────────────── */}
      <section id="barbeiros" className="border-y border-line bg-ink-soft py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <SectionTitle kicker="Nosso time" title="Escolha seu Barbeiro" subtitle="Cada profissional tem agenda própria: folgas, expediente e especialidades únicos." />
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
            {(barbers ?? []).map((b) => (
              <article key={b.id} className="card-luxe reveal group overflow-hidden rounded-2xl border border-line bg-panel text-center">
                <div className="relative h-56 overflow-hidden">
                  <img src={b.photo} alt={b.name} loading="lazy" className="h-full w-full object-cover object-top transition-transform duration-700 group-hover:scale-[1.05]" />
                  <div className="absolute inset-0 bg-gradient-to-t from-panel via-transparent to-transparent" />
                  <div className="absolute bottom-2 left-1/2 -translate-x-1/2">
                    <Badge tone="gold"><Star size={10} className="fill-current" /> {b.rating.toFixed(1)} · {b.reviews_count} avaliações</Badge>
                  </div>
                </div>
                <div className="p-4 pt-3">
                  <h3 className="font-display text-lg font-semibold text-zinc-50">{b.name}</h3>
                  <p className="mt-0.5 text-[12px] uppercase tracking-wider text-[var(--c-gold)]">{b.specialty}</p>
                  <Link to={`${siteBase()}/agendar?barbeiro=${b.id}`} className="btn-gold mt-4 inline-flex w-full items-center justify-center gap-1.5 rounded-lg py-2 text-sm">Agendar com {b.name.split(" ")[0]}</Link>
                </div>
              </article>
            ))}
            {!barbers && <div className="col-span-full"><Spinner /></div>}
          </div>
        </div>
      </section>

      {/* ── LOJA ─────────────────────────────────────────────────────── */}
      {shopEnabled && (
        <section id="loja" className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
          <SectionTitle
            kicker="Loja"
            title="Produtos da Barbearia"
            subtitle="Monte seu carrinho e finalize o pedido pelo WhatsApp — a barbearia confirma disponibilidade e pagamento com você."
          />
          <div className="mb-6 flex items-center justify-center gap-3">
            <Button variant="ghost" onClick={() => setCartOpen(true)}><ShoppingBag size={16} /> Ver carrinho</Button>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {(products ?? []).map((p) => (
              <ProductCard key={p.id} p={p} />
            ))}
            {!products && <div className="col-span-full"><Spinner /></div>}
            {products?.length === 0 && <div className="col-span-full"><EmptyState icon={<ShoppingBag size={26} />} title="Sem produtos no momento" /></div>}
          </div>
        </section>
      )}

      {/* ── AVALIAÇÕES ───────────────────────────────────────────────── */}
      {s?.reviews_enabled !== false && (
        <section id="avaliacoes" className="border-y border-line bg-ink-soft py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionTitle kicker="Quem vive a experiência" title="Avaliações Reais" />
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {(reviews ?? []).slice(0, 6).map((r, i) => (
                <figure key={i} className="reveal rounded-2xl border border-line bg-panel p-5">
                  <div className="mb-2 flex gap-0.5 text-[var(--c-gold)]">
                    {Array.from({ length: 5 }).map((_, j) => <Star key={j} size={14} className={j < r.rating ? "fill-current" : "opacity-25"} />)}
                  </div>
                  <blockquote className="text-sm leading-relaxed text-zinc-300">“{r.comment}”</blockquote>
                  <figcaption className="mt-3 text-xs text-zinc-500">— {r.customer_name} · com <span className="text-zinc-300">{r.barber_name}</span></figcaption>
                </figure>
              ))}
              {reviews?.length === 0 && <div className="col-span-full text-center text-sm text-zinc-500">As avaliações aparecem aqui após os atendimentos concluídos.</div>}
            </div>
          </div>
        </section>
      )}

      {/* ── CONTATO / MAPA ───────────────────────────────────────────── */}
      <section className="mx-auto max-w-6xl px-4 py-20 sm:px-6">
        <SectionTitle kicker="Venha nos visitar" title="Localização & Contato" />
        <div className="grid gap-6 lg:grid-cols-5">
          <div className="reveal overflow-hidden rounded-2xl border border-line lg:col-span-3">
            <iframe
              title="Mapa"
              src={`https://www.google.com/maps?q=${encodeURIComponent(s?.maps_query || s?.address || "")}&z=16&output=embed`}
              className="h-[320px] w-full border-0 grayscale-[35%] contrast-[1.05]"
              loading="lazy"
            />
          </div>
          <div className="reveal flex flex-col gap-4 lg:col-span-2">
            <div className="rounded-2xl border border-line bg-panel p-5">
              <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.25em] text-[var(--c-gold)]">Endereço</p>
              <p className="text-sm leading-relaxed text-zinc-300">{s?.address}</p>
              <p className="mt-3 flex flex-wrap gap-2">
                <a href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(s?.maps_query || s?.address || "")}`} target="_blank" rel="noreferrer" className="btn-ghost rounded-lg px-3 py-1.5 text-xs">Como chegar</a>
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-panel p-5">
              <p className="mb-1 text-[11px] font-bold uppercase tracking-[0.25em] text-[var(--c-gold)]">Fale conosco</p>
              <p className="text-sm text-zinc-300">{s?.phone}{s?.email ? ` · ${s.email}` : ""}</p>
              <Link to="agendar" className="btn-gold mt-4 flex items-center justify-center gap-2 rounded-xl py-3 text-sm"><Send size={15} /> Agendar meu horário agora</Link>
              {s?.whatsapp && (
                <a href={`https://wa.me/${s.whatsapp}`} target="_blank" rel="noreferrer" className="btn-ghost mt-2 flex items-center justify-center gap-2 rounded-xl border py-2.5 text-sm text-zinc-200"><MessageCircle size={15} /> WhatsApp</a>
              )}
            </div>
          </div>
        </div>
      </section>

      <CartDrawer open={cartOpen} onClose={() => setCartOpen(false)} />
    </>
  );
}

/* hook local com react-query */
import { useQuery } from "@tanstack/react-query";
function useQuerySafe<T>(key: string): { data?: T } {
  const q = useQuery({ queryKey: ["tenant", siteBase(), key], queryFn: () => api.get<any>(`/${key}`).then((d) => (key === "services" ? d.services : key === "barbers" ? d.barbers : key === "products" ? d.products : d.reviews) as T),
    staleTime: 0,
    refetchOnMount: "always",
    refetchOnWindowFocus: "always",
    refetchInterval: key === "reviews" ? 60_000 : 5_000,
    refetchIntervalInBackground: false,
  });
  return { data: Array.isArray(q.data) ? (q.data as T) : undefined };
}

function ProductCard({ p }: { p: Product }) {
  const toast = useToast();
  const [adding, setAdding] = useState(false);
  const soldOut = p.stock <= 0 || p.out_of_stock === true;
  const add = () => {
    if (soldOut) return toast.push("err", "Produto esgotado.");
    const cart = readCart();
    const id = String(p.id);
    if (!cart[id] && Object.keys(cart).length >= MAX_CART_LINES)
      return toast.push("err", "O carrinho já atingiu o limite de 20 produtos diferentes.");
    if ((cart[id] || 0) >= Math.min(p.stock, MAX_CART_QTY))
      return toast.push("err", "Quantidade máxima disponível no carrinho.");
    cart[id] = (cart[id] || 0) + 1;
    writeCart(cart);
    setAdding(true);
    toast.push("ok", `${p.name} adicionado ao carrinho.`);
    setTimeout(() => setAdding(false), 900);
  };
  return (
    <article className={clsx("card-luxe reveal flex flex-col overflow-hidden rounded-2xl border bg-panel", soldOut ? "border-line opacity-75" : "border-line")}>
      <div className="relative h-40 overflow-hidden">
        <img src={p.photo} alt={p.name} loading="lazy" className="h-full w-full object-cover" />
        {p.featured ? <div className="absolute left-2 top-2"><Badge tone="gold">Exclusivo</Badge></div> : null}
        {soldOut && <div className="absolute right-2 top-2"><Badge tone="red">Esgotado</Badge></div>}
      </div>
      <div className="flex flex-1 flex-col p-4">
        <h3 className="text-sm font-semibold leading-snug text-zinc-100">{p.name}</h3>
        <p className="mt-1 flex-1 text-xs leading-relaxed text-zinc-500 line-clamp-2">{p.description}</p>
        <div className="mt-3 flex items-center justify-between">
          <p className="font-display text-lg font-semibold text-[var(--c-gold)]">{money(p.price_cents)}</p>
          <span className="text-[11px] text-zinc-500">{p.stock > 0 ? `${p.stock} em estoque` : "—"}</span>
        </div>
        <button onClick={add} disabled={soldOut} className={clsx("mt-3 rounded-lg py-2 text-[13px] font-semibold transition-all", adding ? "bg-emerald-600 text-white" : soldOut ? "cursor-not-allowed bg-zinc-800 text-zinc-500" : "btn-gold")}>
          {adding ? "✓ Adicionado" : soldOut ? "Indisponível" : "Adicionar ao carrinho"}
        </button>
      </div>
    </article>
  );
}
