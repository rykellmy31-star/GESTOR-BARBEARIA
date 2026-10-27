import { useState } from "react";
import { api } from "@/lib/api";
import { Button, Field, Input, Modal, useToast } from "@/components/ui";

const REASONS=["Cliente desistiu","Avisou pelo WhatsApp","Não poderá comparecer","Outro motivo"] as const;
type Reason=(typeof REASONS)[number];

/** Formulário único para barbeiro e administrador. Motivo obrigatório e auditado no backend. */
export function BookingCancelDialog({panel,bookingId,customer,onClose,onDone}:{
 panel:"barber"|"admin";bookingId:number;customer:string;
 onClose:()=>void;onDone:()=>void;
}){
 const toast=useToast();
 const [reason,setReason]=useState<Reason>("Avisou pelo WhatsApp");
 const [details,setDetails]=useState("");
 const [busy,setBusy]=useState(false);
 const submit=async()=>{
  if(busy)return;
  setBusy(true);
  try{
   await api.post(`/${panel}/bookings/${bookingId}/cancel`,{
    reason,details:details.trim()
   });
   toast.push("ok","Reserva cancelada. Horário liberado e motivo registrado no histórico.");
   onDone();
  }catch(e:any){
   toast.push("err",e?.message||"Não foi possível cancelar a reserva.");
  }finally{setBusy(false);}
 };
 return <Modal open onClose={onClose} title="Cancelar agendamento">
  <div className="space-y-3 text-sm">
   <p className="text-zinc-300">Cliente: <b>{customer}</b>. Informe por que o horário será cancelado.</p>
   <Field label="Motivo do cancelamento">
    <select className="input-dark w-full" aria-label="Motivo do cancelamento"
     value={reason} onChange={e=>setReason(e.target.value as Reason)}>
     {REASONS.map(r=><option value={r} key={r}>{r}</option>)}
    </select>
   </Field>
   <Field label="Detalhes adicionais (opcional)">
    <Input value={details} maxLength={120} onChange={e=>setDetails(e.target.value)}
     placeholder="Ex.: cliente avisou às 08h30"/>
   </Field>
   <p className="text-xs text-amber-200">
    O horário será liberado. Se houver Pix pago, este cancelamento não efetua estorno automático.
   </p>
   <div className="flex flex-wrap justify-end gap-2">
    <Button variant="dark" disabled={busy} onClick={onClose}>Voltar</Button>
    <Button variant="danger" disabled={busy} onClick={submit}>
     {busy?"Cancelando…":"Confirmar cancelamento"}
    </Button>
   </div>
  </div>
 </Modal>;
}
