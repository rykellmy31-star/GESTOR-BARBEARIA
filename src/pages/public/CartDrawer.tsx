import { useEffect, useMemo, useState } from "react";
import { Minus, Plus, ShoppingBag, Trash2 } from "lucide-react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, cartEvent, siteBase } from "@/lib/api";
import { MAX_CART_QTY, readCart, reconcileCart, writeCart } from "@/lib/cart";
import { Badge, Button, Field, Input, Modal, Spinner, useToast } from "@/components/ui";
import { maskPhone, money } from "@/lib/format";
import { useConfig } from "@/lib/hooks";
import type { Product } from "@/lib/types";

export function CartDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data, isError, refetch } = useQuery({ queryKey: ["tenant", siteBase(), "products"], queryFn: () => api.get<{ products: Product[] }>("/products").then((d) => d.products) });
  const qc = useQueryClient();
  const {data:cfg}=useConfig();
  const products = data ?? [];
  const [cart, setCart] = useState(readCart);
  const [checkout, setCheckout] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email,setEmail]=useState("");
  const [paymentChoice,setPaymentChoice]=useState<"after_service"|"pix">("after_service");
  const [checkoutKey,setCheckoutKey]=useState(()=>crypto.randomUUID());
  const [checking,setChecking]=useState(false);
  const [busy, setBusy] = useState(false);
  const [placed, setPlaced] = useState<{code:string;link:string|null;payment_choice:string;payment:any;payment_token:string|null}|null>(null);
  const toast = useToast();

  // O drawer permanece montado quando cartões da loja alteram o carrinho.
  useEffect(() => {
    const refresh = () => setCart(readCart());
    window.addEventListener(cartEvent(), refresh);
    return () => window.removeEventListener(cartEvent(), refresh);
  }, []);
  useEffect(() => { if (open) setCart(readCart()); }, [open]);
  useEffect(() => {
    if (!open || !data) return;
    const before = readCart();
    const after = reconcileCart(before, data);
    if (JSON.stringify(before) !== JSON.stringify(after)) writeCart(after);
    setCart(after);
  }, [open, data]);

  const sync = (c: Record<string, number>) => { setCart(c); writeCart(c); };

  const lines = useMemo(() => {
    return Object.entries(cart)
      .map(([id, qty]) => {
        const p = products.find((x) => String(x.id) === id);
        return p ? { p, qty } : null;
      })
      .filter(Boolean) as { p: Product; qty: number }[];
  }, [cart, products]);
  const total = lines.reduce((a, l) => a + l.p.price_cents * Math.min(l.qty, l.p.stock, MAX_CART_QTY), 0);

  const placeOrder = async () => {
    if (!lines.length || !total) return toast.push("err", "Selecione produtos disponíveis para comprar.");
    if (name.trim().length < 2) return toast.push("err", "Informe seu nome.");
    if (phone.replace(/\D/g, "").length < 10) return toast.push("err", "Informe um WhatsApp válido.");
    if(paymentChoice==="pix"&&(!cfg?.payment_options?.pix_enabled||!email.trim()))
      return toast.push("err","Informe e-mail e selecione Pix habilitado.");
    try {
      setBusy(true);
      const res = await api.post<{code:string;whatsapp_link:string|null;payment_choice:string;payment:any;payment_token:string|null}>("/orders", {
        name: name.trim(),
        phone: phone.replace(/\D/g, ""),
        email:email.trim(),paymentChoice,idempotencyKey:checkoutKey,
        items: lines.map((l) => ({ productId: l.p.id, qty: Math.min(l.qty, l.p.stock, MAX_CART_QTY) })),
      });
      setPlaced({code:res.code,link:res.whatsapp_link,payment_choice:res.payment_choice,
        payment:res.payment,payment_token:res.payment_token});
      setCheckoutKey(crypto.randomUUID());
      sync({});
      void qc.invalidateQueries({ queryKey: ["tenant", siteBase(), "products"] });
      if (res.whatsapp_link&&paymentChoice==="after_service") window.open(res.whatsapp_link, "_blank");
      toast.push("ok", paymentChoice==="pix"?`Pedido ${res.code} registrado; confira o Pix.`:`Pedido ${res.code} registrado! Envie a mensagem que abrimos no WhatsApp.`);
    } catch (e: any) {
      toast.push("err", e.message || "Não foi possível registrar o pedido.");
    } finally {
      setBusy(false);
    }
  };

  const checkPayment=async()=>{
    if(!placed?.payment_token)return;
    setChecking(true);
    try{
      const result=await api.post<{payment:any}>("/orders/pix/status",{
        code:placed.code,phone:phone.replace(/\D/g,""),payment_token:placed.payment_token
      });
      setPlaced(p=>p?{...p,payment:result.payment}:p);
    }catch(e:any){toast.push("err",e.message||"Não foi possível consultar pagamento.");}
    finally{setChecking(false);}
  };
  return (
    <Modal open={open} onClose={() => { setPlaced(null); setCheckout(false); onClose(); }} title="Carrinho">
      {isError && !data ? (
        <div className="py-6 text-center text-sm text-zinc-400">
          Não foi possível consultar o catálogo. Verifique sua conexão.
          <div className="mt-3"><Button onClick={() => void refetch()}>Tentar novamente</Button></div>
        </div>
      ) : !data ? <div className="py-8"><Spinner /></div> : placed ? (
        <div className="py-4 text-center">
          <div className="mx-auto mb-3 flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400"><ShoppingBag size={24} /></div>
          <p className="font-display text-xl text-zinc-100">Pedido registrado: {placed.code}</p>
          <p className="mx-auto mt-2 max-w-sm text-sm text-zinc-400">
            {placed.payment_choice==="pix" ? "Pedido registrado. O valor será recebido diretamente pela barbearia no Mercado Pago." : "Envie a mensagem pelo WhatsApp para combinar a retirada e o pagamento."}
          </p>
          {placed.payment_choice==="pix"&&(
            <div className="mt-4 rounded-xl border border-line bg-ink-soft p-4 text-left text-xs">
              <p className="font-semibold text-zinc-100">Pix de produtos · {money(placed.payment?.amount_cents||total)}</p>
              <p className="mt-2 text-zinc-300">{placed.payment?.status==="paid"?"Pagamento confirmado.":
                placed.payment?.status==="pending"?"Aguardando Pix. Não pague duas vezes.":
                placed.payment?.message||"Pagamento indisponível; fale com a barbearia."}</p>
              {placed.payment?.status==="pending"&&placed.payment.qr_code_base64&&
                <img className="mx-auto mt-3 w-44 rounded-lg bg-white p-2"
                  src={"data:image/png;base64,"+placed.payment.qr_code_base64} alt="QR Code Pix da compra" />}
              {placed.payment?.status==="pending"&&placed.payment.qr_code_text&&
                <div className="mt-3 space-y-2">
                  <p className="break-all rounded bg-black/30 p-2 text-zinc-200">{placed.payment.qr_code_text}</p>
                  <Button variant="ghost" size="sm" onClick={()=>navigator.clipboard.writeText(placed.payment.qr_code_text)
                    .then(()=>toast.push("ok","Pix copiado.")).catch(()=>toast.push("err","Não foi possível copiar."))}>
                    Copiar Pix
                  </Button>
                </div>}
              <Button variant="ghost" className="mt-3" disabled={checking||!placed.payment_token}
                onClick={checkPayment}>{checking?"Consultando…":"Verificar pagamento"}</Button>
            </div>
          )}
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
                  <span className="w-6 text-center text-sm">{Math.min(qty, p.stock, MAX_CART_QTY)}</span>
                  <button className="rounded-md border border-line p-1 text-zinc-300 hover:border-[var(--c-gold)]" onClick={() => sync({ ...cart, [p.id]: Math.min(p.stock, MAX_CART_QTY, qty + 1) })}><Plus size={12} /></button>
                  <button className="ml-1 text-zinc-500 hover:text-red-400" onClick={() => { const c = { ...cart }; delete c[String(p.id)]; sync(c); }}><Trash2 size={14} /></button>
                </div>
                <p className="w-20 text-right text-sm font-semibold text-[var(--c-gold)]">{money(p.price_cents * Math.min(qty, p.stock, MAX_CART_QTY))}</p>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex items-center justify-between border-t border-line pt-4">
            <p className="text-sm text-zinc-400">Total</p>
            <p className="font-display text-2xl text-[var(--c-gold)]">{money(total)}</p>
          </div>
          <Button className="mt-4 w-full" disabled={!lines.length || !total} onClick={() => setCheckout(true)}>Finalizar pedido pelo WhatsApp</Button>
          <p className="mt-2 text-center text-[11px] text-zinc-600">Escolha pagar na retirada ou pagar agora com Pix na próxima etapa.</p>
        </div>
      ) : (
        <div className="space-y-4">
          <Badge tone="gold">Pedido: {money(total)} em {lines.length} item(ns)</Badge>
          <Field label="Seu nome" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: João Silva" /></Field>
          <Field label="WhatsApp" required hint="Usaremos este número para confirmar seu pedido"><Input value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} placeholder="(75) 99999-0000" inputMode="tel" /></Field>
          <div className="space-y-2">
            <p className="text-sm font-semibold text-zinc-100">Como deseja pagar?</p>
            <label className="flex gap-2 text-xs text-zinc-300"><input type="radio" name="product-payment"
              checked={paymentChoice==="after_service"} onChange={()=>setPaymentChoice("after_service")}/>
              Pagar na retirada ou após o atendimento
            </label>
            <label className="flex gap-2 text-xs text-zinc-300"><input type="radio" name="product-payment"
              checked={paymentChoice==="pix"} disabled={!cfg?.payment_options?.pix_enabled}
              onChange={()=>setPaymentChoice("pix")}/> Pagar agora com Pix · {money(total)}
              {!cfg?.payment_options?.pix_enabled?" (indisponível)":""}
            </label>
          </div>
          {paymentChoice==="pix"&&<Field label="E-mail para Pix" required>
            <Input type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="seu@email.com" />
          </Field>}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setCheckout(false)}>Voltar</Button>
            <Button className="flex-1" onClick={placeOrder} disabled={busy}>{busy ? "Registrando…" : paymentChoice==="pix"?"Registrar e gerar Pix":"Confirmar e enviar no WhatsApp"}</Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
