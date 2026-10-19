import { useMemo, useState } from "react";
import { Minus, Plus, ShoppingBag, Trash2 } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { api, cartKey, cartEvent } from "@/lib/api";
import { Badge, Button, Field, Input, Modal, Spinner, useToast } from "@/components/ui";
import { maskPhone, money } from "@/lib/format";
import type { Product } from "@/lib/types";

export function readCart(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(cartKey()) || "{}"); } catch { return {}; }
}
export function writeCart(cart: Record<string, number>) {
  localStorage.setItem(cartKey(), JSON.stringify(cart));
  window.dispatchEvent(new Event(cartEvent()));
}

export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data } = useQuery({ queryKey: ["products"], queryFn: () => api.get<{ products: Product[] }>("/products").then((d) => d.products) });
  const products = data ?? [];
  const [cart, setCart] = useState(readCart);
  const [checkout, setCheckout] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<{ code: string; link: string | null } | null>(null);
  const toast = useToast();

  const sync = (c: Record<string, number>) => { setCart(c); writeCart(c); };

  const lines = useMemo(() => {
    return Object.entries(cart)
      .map(([id, qty]) => {
        const p = products.find((x) => String(x.id) === id);
        return p ? { p, qty } : null;
      })
      .filter(Boolean) as { p: Product; qty: number }[];
  }, [cart, products]);
  const total = lines.reduce((a, l) => a + l.p.price_cents * Math.min(l.qty, l.p.stock), 0);

  const placeOrder = async () => {
    if (name.trim().length < 2) return toast.push("err", "Informe seu nome.");
    if (phone.replace(/\D/g, "").length < 10) return toast.push("err", "Informe um WhatsApp válido.");
    try {
      setBusy(true);
      const res = await api.post<{ code: string; whatsapp_link: string | null; message: string }>("/orders", {
        name: name.trim(),
        phone: phone.replace(/\D/g, ""),
        items: lines.map((l) => ({ productId: l.p.id, qty: Math.min(l.qty, l.p.stock) })),
      });
      setPlaced({ code: res.code, link: res.whatsapp_link });
      sync({});
      if (res.whatsapp_link) window.open(res.whatsapp_link, "_blank");
      toast.push("ok", `Pedido ${res.code} registrado! Envie a mensagem que abrimos no WhatsApp.`);
    } catch (e: any) {
      toast.push("err", e.message || "Não foi possível registrar o pedido.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={() => { setPlaced(null); setCheckout(false); onClose(); }} title="Carrinho">
      {placed ? (
        <div className="py-4 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400"><ShoppingBag size={24} /></div>
          <p className="font-display text-xl text-zinc-100">Pedido registrado: {placed.code}</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-400">
            Abrimos o WhatsApp da barbearia com sua mensagem formatada. <b className="text-zinc-200">Envie por lá para concluir</b> — a loja confirma estoque e combina o pagamento (Pix ou na retirada).
          </p>
          {placed.link && <a href={placed.link} target="_blank" rel="noreferrer" className="btn-gold mt-4 inline-flex rounded-xl px-5 py-2.5 text-sm">Reabrir WhatsApp</a>}
          <div className="mt-4"><Button variant="ghost" onClick={() => { setPlaced(null); onClose(); }}>Fechar</Button></div>
        </div>
      ) : lines.length === 0 ? (
        <div className="py-8 text-center">
          <ShoppingBag size={30} className="mx-auto mb-2 text-zinc-600" />
          <p className="text-sm text-zinc-400">Seu carrinho está vazio.</p>
          <p className="text-xs text-zinc-600">Adicione produtos da seção Loja.</p>
        </div>
      ) : !checkout ? (
        <div>
          <ul className="divide-y divide-line">
            {lines.map(({ p, qty }) => (
              <li key={p.id} className="flex items-center gap-3 py-3">
                <img src={p.photo} alt="" className="h-12 w-12 rounded-lg object-cover" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-zinc-100">{p.name}</p>
                  <p className="text-xs text-zinc-500">{money(p.price_cents)} · {p.stock} disp.</p>
                </div>
                <div className="flex items-center gap-1.5">
                  <button className="rounded-md border border-line p-1 text-zinc-300 hover:border-[var(--c-gold)]" onClick={() => sync({ ...cart, [p.id]: Math.max(1, qty - 1) })} disabled={qty <= 1}><Minus size={12} /></button>
                  <span className="w-6 text-center text-sm">{Math.min(qty, p.stock)}</span>
                  <button className="rounded-md border border-line p-1 text-zinc-300 hover:border-[var(--c-gold)]" onClick={() => sync({ ...cart, [p.id]: Math.min(p.stock, qty + 1) })}><Plus size={12} /></button>
                  <button className="ml-1 text-zinc-500 hover:text-red-400" onClick={() => { const c = { ...cart }; delete c[String(p.id)]; sync(c); }}><Trash2 size={14} /></button>
                </div>
                <p className="w-20 text-right text-sm font-semibold text-[var(--c-gold)]">{money(p.price_cents * Math.min(qty, p.stock))}</p>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
            <p className="text-sm text-zinc-400">Total</p>
            <p className="font-display text-2xl text-[var(--c-gold)]">{money(total)}</p>
          </div>
          <Button className="mt-4 w-full" onClick={() => setCheckout(true)}>Finalizar pedido pelo WhatsApp</Button>
          <p className="mt-2 text-center text-[11px] text-zinc-600">Pedido comercial — o pagamento é combinado com a barbearia. Pagamento online (Pix/cartão) é recurso futuro previsto na arquitetura.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <Badge tone="gold">Pedido: {money(total)} em {lines.length} item(ns)</Badge>
          <Field label="Seu nome" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: João Silva" /></Field>
          <Field label="WhatsApp" required hint="Usaremos este número para confirmar seu pedido"><Input value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} placeholder="(75) 99999-0000" inputMode="tel" /></Field>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setCheckout(false)}>Voltar</Button>
            <Button className="flex-1" onClick={placeOrder} disabled={busy}>{busy ? "Registrando…" : "Confirmar e enviar no WhatsApp"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
