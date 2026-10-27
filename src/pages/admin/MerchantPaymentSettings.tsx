import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, siteBase } from "@/lib/api";
import { Button, Field, Input, useToast } from "@/components/ui";

interface Integration {
 connected:boolean;enabled:boolean;account_id:string|null;webhook_url:string|null;pix_available:boolean;
}
export function MerchantPaymentSettings() {
 const toast=useToast(),qc=useQueryClient(),tenant=siteBase();
 const query=useQuery({queryKey:["merchant-payment",tenant],
  queryFn:()=>api.get<{integration:Integration}>("/admin/payments/mercadopago").then(r=>r.integration),retry:false});
 const [token,setToken]=useState(""),[secret,setSecret]=useState("");
 const [busy,setBusy]=useState(false);
 const save=async()=>{
  setBusy(true);
  try{
   await api.put("/admin/payments/mercadopago",{access_token:token.trim(),webhook_secret:secret.trim()});
   setToken("");setSecret("");
   await query.refetch();await qc.invalidateQueries({queryKey:["config"]});
   toast.push("ok","Conta Mercado Pago da barbearia validada e salva com criptografia.");
  }catch(e:any){toast.push("err",e.message||"Falha ao conectar Mercado Pago.");}
  finally{setBusy(false);}
 };
 const disconnect=async()=>{
  if(!window.confirm("Desconectar a conta da barbearia? Novos pagamentos Pix serão bloqueados."))return;
  setBusy(true);
  try{
   await api.del("/admin/payments/mercadopago");
   await query.refetch();await qc.invalidateQueries({queryKey:["config"]});
   toast.push("ok","Conta da barbearia desconectada.");
  }catch(e:any){toast.push("err",e.message||"Não foi possível desconectar.");}
  finally{setBusy(false);}
 };
 return (
  <section className="rounded-2xl border border-line bg-panel p-5">
   <h2 className="font-display text-lg text-zinc-100">Mercado Pago da barbearia</h2>
   <p className="mt-1 text-xs leading-relaxed text-zinc-400">
    O dinheiro de cortes, barba e produtos vai direto para a sua conta Mercado Pago.
    Esta integração não paga créditos, planos ou mensalidades do TIGU.
   </p>
   {query.isLoading?<p className="mt-3 text-sm text-zinc-400">Consultando integração…</p>:
    query.isError?<p className="mt-3 text-sm text-amber-300">Somente o proprietário pode administrar a conta de recebimentos.</p>:(
    <div className="mt-4 space-y-3">
     <p className="text-sm text-zinc-300">
      {query.data?.connected?"Conta vinculada: "+query.data.account_id:"Nenhuma conta vinculada"}
      {" · "}{query.data?.pix_available?"Pix online habilitado":"Pix online indisponível"}
     </p>
     <Field label="Access Token de produção" hint="Cole o token PRIVADO da sua conta Mercado Pago; ele não será exibido após salvar.">
      <Input type="password" autoComplete="off" value={token} onChange={e=>setToken(e.target.value)}
       placeholder="Token de produção do proprietário" />
     </Field>
     <Field label="Chave secreta do Webhook" hint="Disponível em Suas integrações > Webhooks na sua conta Mercado Pago.">
      <Input type="password" autoComplete="off" value={secret} onChange={e=>setSecret(e.target.value)}
       placeholder="Assinatura secreta do seu aplicativo" />
     </Field>
     <Button disabled={busy||token.trim().length<25||secret.trim().length<16} onClick={save}>
      {busy?"Validando…":"Validar e salvar conta"}
     </Button>
     {query.data?.webhook_url&&(
      <div className="rounded-lg border border-line bg-ink-soft p-3 text-xs text-zinc-400">
       <p className="font-semibold text-zinc-200">URL de notificações da sua barbearia</p>
       <p className="mt-1 break-all">{query.data.webhook_url}</p>
       <Button variant="ghost" size="sm" className="mt-2" onClick={()=>
        navigator.clipboard.writeText(query.data!.webhook_url!).then(()=>toast.push("ok","URL copiada."))
         .catch(()=>toast.push("err","Não foi possível copiar."))}>Copiar URL</Button>
      </div>
     )}
     {query.data?.connected&&(
      <Button variant="danger" disabled={busy} onClick={disconnect}>Desconectar conta recebedora</Button>
     )}
     <p className="text-[11px] text-zinc-500">
      Os pagamentos online só ficam disponíveis depois da validação da conta e da liberação do recurso
      no ambiente de produção. Não compartilhe o token com clientes.
     </p>
    </div>
   )}
  </section>
 );
}
