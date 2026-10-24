import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarClock, CheckCircle2, Clock3, LogOut, Phone, Star, UserX } from "lucide-react";
import { clsx } from "clsx";
import { api, siteBase } from "@/lib/api";
import { useAuth, useConfig } from "@/lib/hooks";
import { NotificationsBell } from "@/components/layout/PanelLayout";
import { BookingCancelDialog } from "@/components/BookingCancelDialog";
import { Badge, Button, EmptyState, Field, Input, Modal, Spinner, Textarea, useToast } from "@/components/ui";
import { fmtDayLong, fromMinutes, localDay, money, toMinutes } from "@/lib/format";

const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
type ProfessionalService={service_id:number;name:string;duration_min:number;default_duration_min:number;duration_override_min:number|null};

export function BarberPanelPage() {
  const { data: cfg } = useConfig();
  const tz = cfg?.settings.timezone || "America/Bahia";
  const { logout } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState(0);
  const [blockOpen, setBlockOpen] = useState(false);
  const [fitOpen, setFitOpen] = useState(false);
  const [cancelItem,setCancelItem]=useState<{id:number;name:string}|null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    const outcome = url.searchParams.get("mp");
    if (outcome !== "connected" && outcome !== "failed") return;
    toast.push(outcome === "connected" ? "ok" : "err",
      outcome === "connected"
        ? "Conta Mercado Pago autorizada. Os pagamentos serão liberados após homologação."
        : "Não foi possível autorizar a conta Mercado Pago. Tente conectar novamente.");
    url.searchParams.delete("mp");
    window.history.replaceState(window.history.state, "", url.pathname + url.search + url.hash);
    void qc.invalidateQueries({ queryKey: ["barber-mercadopago", siteBase()] });
  }, [qc, toast]);

  const me = useQuery({ queryKey: ["barber-me", siteBase()], queryFn: () => api.get<any>("/barber/me") });
  const marketplace = useQuery({ queryKey: ["barber-mercadopago", siteBase()], queryFn: () => api.get<{ connected:boolean; enabled:boolean; can_connect:boolean; notice:string }>("/barber/mercadopago") });
  const serviceTimes=useQuery({queryKey:["barber-service-durations",siteBase()],
    queryFn:()=>api.get<{services:ProfessionalService[]}>("/barber/service-durations")});
  const saveDuration=useMutation({
    mutationFn:({serviceId,duration}: {serviceId:number;duration:number|null})=>
      api.put("/barber/service-durations/"+serviceId,{duration_min:duration}),
    onSuccess:()=>{void qc.invalidateQueries({queryKey:["barber-service-durations",siteBase()]});
      toast.push("ok","Tempo de atendimento atualizado; novas reservas respeitarão sua duração.");},
    onError:(e:any)=>toast.push("err",e.message||"Não foi possível salvar o tempo."),
  });
  const connectMp = useMutation({
    mutationFn: () => api.post<{ authorization_url: string }>("/barber/mercadopago/connect", {}),
    onSuccess: ({ authorization_url }) => {
      const url = new URL(authorization_url);
      if (url.origin !== "https://auth.mercadopago.com" || url.pathname !== "/authorization") {
        toast.push("err", "Endereço de autorização inválido.");
        return;
      }
      window.location.assign(url.toString());
    },
    onError: (e: any) => toast.push("err", e.message || "Não foi possível conectar o Mercado Pago."),
  });
  const disconnectMp = useMutation({
    mutationFn: () => api.post<{ ok: boolean }>("/barber/mercadopago/disconnect", {}),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["barber-mercadopago", siteBase()] }); toast.push("ok", "Conta desconectada do TIGU."); },
    onError: (e: any) => toast.push("err", e.message || "Falha ao desconectar a conta."),
  });
  const days = useMemo(() => {
    const start = localDay(tz);
    return Array.from({ length: 7 }, (_, i) =>
      new Date(Date.parse(`${start}T12:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10)
    );
  }, [tz]);
  const agenda = useQuery({
    queryKey: ["barber-agenda", siteBase(), days[0]],
    queryFn: () => api.get<any>(`/barber/agenda?from=${days[0]}&days=7`),
    refetchInterval: 30_000,
  });
  const finishEarly=useMutation({
    mutationFn:(id:number)=>api.post<{ok:boolean;minutesAvailable:number}>("/barber/bookings/"+id+"/finish-early",{}),
    onSuccess:({minutesAvailable})=>{
      void qc.invalidateQueries({queryKey:["barber-agenda",siteBase()]});
      toast.push("ok",Math.round(minutesAvailable)+" minutos liberados para encaixe na sua agenda.");},
    onError:(e:any)=>toast.push("err",e.message||"Não foi possível liberar o horário."),
  });
  const checkIn=useMutation({
    mutationFn:(id:number)=>api.post<{ok:boolean;checkedInAt:string}>("/barber/bookings/"+id+"/check-in",{}),
    onSuccess:()=>{
      void qc.invalidateQueries({queryKey:["barber-agenda",siteBase()]});
      toast.push("ok","Chegada confirmada! Cliente presente na barbearia.");
    },
    onError:(e:any)=>toast.push("err",e.message||"Não foi possível registrar a chegada."),
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: any) => api.patch(`/barber/bookings/${id}/status`, { status }),
    onSuccess: (_v, args) => { qc.invalidateQueries({ queryKey: ["barber-agenda", siteBase()] }); qc.invalidateQueries({ queryKey: ["/barber/notifications", siteBase().split("/")[2]] }); toast.push("ok", `Reserva marcada como ${args.status}.`); },
    onError: (e: any) => toast.push("err", e.message),
  });

  if (me.isLoading || agenda.isLoading) return <div className="grid min-h-screen place-items-center"><Spinner label="Abrindo sua agenda…" /></div>;
  if (me.isError || agenda.isError) return (
    <div role="alert" className="mx-auto mt-20 max-w-lg rounded-2xl border border-amber-500/40 bg-panel p-6 text-sm text-amber-200">
      Não foi possível carregar o painel do profissional.
      <button className="ml-2 underline" onClick={() => { void me.refetch(); void agenda.refetch(); }}>Tentar novamente</button>
    </div>
  );
  const barber = me.data?.barber;
  const perms = me.data?.permissions;
  if (!barber) return <div className="grid min-h-screen place-items-center text-sm text-zinc-400">Usuário sem barbeiro vinculado — fale com o proprietário.</div>;

  const day = days[tab];
  const items = (agenda.data?.days?.[day] ?? []);
  const weekday = (new Date(`${day}T12:00:00Z`).getUTCDay());
  const worksToday = (agenda.data?.work_days ?? []).includes(weekday);
  const isBlocked = (agenda.data?.blocked ?? []).some((b: any) => b.date_from <= day && b.date_to >= day);
  const revenue = items.filter((x: any) => x.status === "concluido").reduce((a: number, x: any) => a + Number(x.price_cents), 0);

  return (
    <div className="texture min-h-screen">
      <header className="sticky top-0 z-40 border-b border-line bg-ink backdrop-blur">
        <div className="mx-auto flex h-16 max-w-3xl items-center gap-3 px-4">
          <img src={barber.photo} alt="" className="h-9 w-9 rounded-full object-cover" />
          <div className="min-w-0">
            <p className="truncate font-display text-[17px] leading-tight text-zinc-50">{barber.name}</p>
            <p className="text-[10px] uppercase tracking-[0.25em] text-[var(--c-gold)]">Painel do profissional · {cfg?.settings.shop_name}</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <NotificationsBell panel="barber" />
            <button className="rounded-lg border border-line p-2 text-zinc-400 hover:text-red-300" onClick={() => logout.mutateAsync().then(() => navigate("/login"))} aria-label="Sair"><LogOut size={16} /></button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
        <section className="rounded-xl border border-line bg-panel p-4" aria-label="Recebimentos Mercado Pago do profissional">
          <h2 className="font-display text-lg text-zinc-100">Meus recebimentos — Mercado Pago</h2>
          <p className="mt-1 text-xs text-zinc-400">
            Sua conta pessoal será usada para receber pelos próprios cortes. Pagamentos de planos e créditos do TIGU pertencem à plataforma e ficam separados.
          </p>
          <p role="status" className="mt-3 text-sm text-amber-200">
            {marketplace.isError ? "Não foi possível consultar a integração." : marketplace.isLoading ? "Consultando sua integração…" : marketplace.data?.notice}
          </p>
          <button type="button" disabled={!marketplace.data?.can_connect || connectMp.isPending}
            onClick={() => connectMp.mutate()}
            className="mt-3 rounded-lg border border-line px-4 py-2 text-sm text-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-500">
            {marketplace.data?.connected ? "Reconectar minha conta Mercado Pago" : "Conectar minha conta Mercado Pago"}
            {!marketplace.data?.can_connect ? " — indisponível neste ambiente" : ""}
          </button>
          {marketplace.data?.connected && (
            <button type="button" disabled={disconnectMp.isPending} onClick={() => {
              if (window.confirm("Desconectar a conta Mercado Pago do TIGU? Novos recebimentos nesta conta serão indisponíveis até reconectar.")) disconnectMp.mutate();
            }} className="ml-2 mt-3 rounded-lg border border-red-500/40 px-4 py-2 text-sm text-red-300 disabled:opacity-50">
              Desconectar conta
            </button>
          )}
          <p className="mt-2 text-xs text-zinc-500">Não informe sua senha nem cole um Access Token no painel. A futura conexão usará a autorização oficial do Mercado Pago.</p>
        </section>
        <section className="rounded-xl border border-line bg-panel p-4" aria-label="Meus tempos de serviços">
          <h2 className="font-display text-lg text-zinc-100">Meu tempo por serviço</h2>
          <p className="mb-3 mt-1 text-xs text-zinc-400">Personalize sua duração de cada serviço. O valor e os demais profissionais não mudam. Agendamentos existentes mantêm seus horários.</p>
          {serviceTimes.isLoading && <Spinner label="Carregando serviços…" />}
          {serviceTimes.isError && <p role="alert" className="text-sm text-red-300">Não foi possível carregar seus serviços.</p>}
          {serviceTimes.data?.services.map(x=><DurationEditor key={x.service_id+":"+x.duration_override_min}
            service={x} pending={saveDuration.isPending}
            onSave={duration=>saveDuration.mutate({serviceId:x.service_id,duration})}/>)}
          {serviceTimes.data?.services.length===0&&<p className="text-sm text-zinc-400">O administrador ainda não atribuiu serviços ao seu perfil.</p>}
        </section>
        {/* dias */}
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {days.map((d, i) => {
            const n = (agenda.data?.days?.[d] ?? []).filter((x: any) => ["pendente", "confirmado"].includes(x.status)).length;
            return (
              <button key={d} onClick={() => setTab(i)} className={clsx("flex min-w-[64px] flex-col items-center rounded-xl border px-3 py-2 text-sm transition-all", tab === i ? "border-[var(--c-gold)] bg-gold-soft text-[var(--c-gold)]" : "border-line bg-panel text-zinc-300")}>
                <span className="text-[10px] uppercase tracking-wide opacity-70">{DAY_NAMES[new Date(`${d}T12:00:00Z`).getUTCDay()]}</span>
                <span className="font-display text-lg leading-tight">{d.slice(8)}</span>
                <span className="text-[10px] text-zinc-500">{n ? `${n} reserva${n > 1 ? "s" : ""}` : "livre"}</span>
              </button>
            );
          })}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-sm text-zinc-400">
            <CalendarClock size={15} className="mr-1.5 inline text-[var(--c-gold)]" />
            {fmtDayLong(day)}
            {isBlocked ? <Badge tone="blue">dia bloqueado</Badge> : !worksToday ? <Badge tone="gray">fora do seu expediente</Badge> : null}
          </p>
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <span className="inline-flex items-center gap-1"><Star size={12} className="fill-current text-[var(--c-gold)]" />{Number(barber.rating ?? 0).toFixed(1)}</span>
            <span>·</span>
            <span>concluído no dia: <b className="text-[var(--c-gold)]">{money(revenue)}</b></span>
            <Button size="sm" variant="dark" disabled={!serviceTimes.data?.services.length}
              onClick={() => setFitOpen(true)}><CalendarClock size={13}/> Encaixar cliente</Button>
            {perms?.can_block && <Button size="sm" variant="dark" onClick={() => setBlockOpen(true)}><Ban size={12} /> Pedir bloqueio</Button>}
          </div>
        </div>

        {/* lista */}
        {items.length === 0 ? (
          <EmptyState icon={<Clock3 size={26} />} title={isBlocked ? "Dia bloqueado" : "Nenhuma reserva neste dia"} text={isBlocked ? "Você está de folga/feriado. Bom descanso!" : "A agenda é aberta ao público em tempo real — quanto mais rápida a resposta no sino, mais clientes voltam."} />
        ) : (
          <ul className="space-y-2">
            {items.map((it: any) => (
              <li key={it.id} className={clsx("rounded-2xl border bg-panel p-4", it.status === "bloqueio" ? "border-sky-500/40" : "border-line")}>
                {it.status === "bloqueio" ? (
                  <p className="text-sm text-sky-300"><Ban size={13} className="mr-1.5 inline" /> {it.notes || "Bloqueio de agenda"} <span className="text-zinc-500">({it.label})</span></p>
                ) : (
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                    <span className="rounded-lg bg-gold-soft px-2.5 py-1 font-mono text-sm font-bold text-[var(--c-gold)]">{it.label}</span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium text-zinc-100">{it.customer_name}</p>
                      <p className="truncate text-xs text-zinc-500">{it.service_name} · {it.duration_min} min · {money(it.price_cents)} {it.origin === "barbeiro" ? "· manual" : ""}</p>
                      {it.notes && <p className="truncate text-[11px] italic text-zinc-500">“{it.notes}”</p>}
                      {it.cancel_reason && <p className="text-xs text-red-300">Motivo do cancelamento: {it.cancel_reason}</p>}
                      {it.checked_in_at&&<p className="text-xs text-emerald-300">
                        Cliente chegou às {new Date(it.checked_in_at).toLocaleTimeString("pt-BR",{timeZone:tz,hour:"2-digit",minute:"2-digit"})}
                      </p>}
                    </div>
                    {it.checked_in_at&&<Badge tone="green">Chegou</Badge>}
                    <Badge tone={it.status === "confirmado" ? "green" : it.status === "concluido" ? "gray" : ["no_show","cancelado"].includes(it.status) ? "red" : "amber"}>{it.status}</Badge>
                    {it.customer_phone && (
                      <a href={`https://wa.me/${String(it.customer_phone).replace(/\D/g, "").replace(/^(?!55)/, "55")}`} target="_blank" rel="noreferrer" className="rounded-lg border border-line p-1.5 text-zinc-400 hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]" aria-label="WhatsApp do cliente"><Phone size={14} /></a>
                    )}
                    {["pendente", "confirmado"].includes(it.status) && (
                      <span className="flex flex-wrap gap-1.5">
                        {!it.checked_in_at&&<Button size="sm" variant="dark" disabled={checkIn.isPending}
                          onClick={()=>checkIn.mutate(it.id)}><CheckCircle2 size={13}/> Cliente chegou</Button>}
                        {perms?.can_conclude && <Button size="sm" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: it.id, status: "concluido" })}><CheckCircle2 size={13} /> Concluir</Button>}
                        {perms?.can_conclude && Date.now()>=Date.parse(it.starts_at) &&
                          Date.now()+5*60000<Date.parse(it.ends_at) && (
                          <Button size="sm" variant="dark" disabled={finishEarly.isPending} onClick={()=>{
                            if(window.confirm("Atendimento terminou mais cedo? Concluir e liberar o restante do horário para encaixe?"))
                              finishEarly.mutate(it.id);
                          }}><Clock3 size={13}/> Concluir antes e liberar vaga</Button>
                        )}
                        {perms?.can_conclude && <Button size="sm" variant="dark" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: it.id, status: "no_show" })}><UserX size={13} /> Faltou</Button>}
                        {perms?.can_cancel && <Button size="sm" variant="danger"
  onClick={()=>setCancelItem({id:it.id,name:it.customer_name})}>Cancelar com motivo</Button>}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>

      {cancelItem&&<BookingCancelDialog panel="barber" bookingId={cancelItem.id}
        customer={cancelItem.name} onClose={()=>setCancelItem(null)} onDone={()=>{
          setCancelItem(null);void qc.invalidateQueries({queryKey:["barber-agenda",siteBase()]});
        }}/>}
      {fitOpen&&<FitInModal day={day} tz={tz} services={serviceTimes.data?.services??[]}
        onClose={()=>setFitOpen(false)} onDone={()=>{
          setFitOpen(false);void qc.invalidateQueries({queryKey:["barber-agenda",siteBase()]});
          toast.push("ok","Encaixe registrado e horário reservado.");}}/>}
      {blockOpen && <BlockRequestModal day={day} onClose={() => setBlockOpen(false)} onDone={() => { setBlockOpen(false); toast.push("ok", "Pedido enviado ao administrador."); }} />}
    </div>
  );
}

function BlockRequestModal({ day, onClose, onDone }: { day: string; onClose: () => void; onDone: () => void }) {
  const { data: cfg } = useConfig();
  const tz = cfg?.settings.timezone || "America/Bahia";
  const [f, setF] = useState({ day, from: "13:00", to: "14:00", reason: "" });
  const send = useMutation({
    mutationFn: () => api.post("/barber/block-requests", { date: f.day, startMin: toMinutes(f.from), endMin: toMinutes(f.to), reason: f.reason }),
    onSuccess: onDone,
    onError: (e: any) => alert(e.message),
  });
  return (
    <Modal open onClose={onClose} title="Solicitar bloqueio de agenda">
      <p className="mb-3 text-xs leading-relaxed text-zinc-500">Médico, curso, compromisso… descreva aqui: o administrador aprova e o horário sai da sua grade no site (clientes já agendados precisam ser remarcados antes).</p>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          <Field label="Data"><Input type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></Field>
          <Field label="Início"><Input type="time" step={300} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="Fim"><Input type="time" step={300} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        </div>
        <Field label="Motivo" required hint="mín. 3 caracteres"><Textarea value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="ex.: consulta odontológica de rotina" /></Field>
        <p className="text-[11px] text-zinc-600">Solicitando {fromMinutes(toMinutes(f.from))}–{fromMinutes(toMinutes(f.to))} de {f.day.split("-").reverse().join("/")}</p>
        <Button className="w-full justify-center" disabled={f.reason.trim().length < 3 || send.isPending} onClick={() => send.mutate()}>{send.isPending ? "Enviando…" : "Enviar para aprovação"}</Button>
      </div>
    </Modal>
  );
}


function DurationEditor({service,pending,onSave}:{
 service:ProfessionalService;pending:boolean;onSave:(duration:number|null)=>void
}){
 const [duration,setDuration]=useState(String(service.duration_min));
 const n=Number(duration);
 return <div className="flex flex-wrap items-end gap-2 border-b border-line py-3 last:border-0">
   <div className="min-w-[120px] flex-1">
     <p className="text-sm font-medium text-zinc-100">{service.name}</p>
     <p className="text-xs text-zinc-500">Padrão: {service.default_duration_min} min
       {service.duration_override_min!=null?" · personalizado":""}</p>
   </div>
   <label className="text-xs text-zinc-400">Meus minutos
     <input aria-label={"Duração de "+service.name} className="input-dark mt-1 w-24" type="number"
       inputMode="numeric" min={5} max={480} step={5} value={duration}
       onChange={e=>setDuration(e.target.value)}/>
   </label>
   <Button size="sm" disabled={pending||!Number.isInteger(n)||n<5||n>480||n%5!==0}
     onClick={()=>onSave(n)}>Salvar</Button>
   {service.duration_override_min!=null&&<Button size="sm" variant="ghost" disabled={pending}
     onClick={()=>onSave(null)}>Usar padrão</Button>}
 </div>;
}

function FitInModal({day,tz,services,onClose,onDone}:{
 day:string;tz:string;services:ProfessionalService[];onClose:()=>void;onDone:()=>void
}){
 const toast=useToast();
 const [serviceId,setServiceId]=useState(services[0]?.service_id??0);
 const svc=services.find(s=>s.service_id===serviceId);
 const [date,setDate]=useState(day);
 const [startTime,setStartTime]=useState("");
 const [minutes,setMinutes]=useState(String(Math.min(services[0]?.duration_min??40,180)));
 const [name,setName]=useState("");
 const [phone,setPhone]=useState("");
 const [idempotencyKey]=useState(()=>crypto.randomUUID());
 const m=Number(minutes);
 const canSave=Boolean(serviceId&&date&&/^([01]\d|2[0-3]):[0-5]\d$/.test(startTime)
    &&name.trim().length>=2&&phone.replace(/\D/g,"").length>=10
    &&Number.isInteger(m)&&m>=5&&m<=Math.min(180,svc?.duration_min??0)&&m%5===0);
 const send=useMutation({
   mutationFn:()=>api.post("/barber/fit-in",{
    serviceId,day:date,startTime,fitInDurationMin:m,name:name.trim(),
    phone:phone.replace(/\D/g,""),idempotencyKey
   }),
   onSuccess:onDone,
   onError:(e:any)=>toast.push("err",e.message||"Horário indisponível. Confira o encaixe."),
 });
 return <Modal open title="Encaixar cliente na minha agenda" onClose={onClose}>
  <p className="mb-3 text-xs text-zinc-400">Use somente um intervalo livre. É possível reduzir a duração deste encaixe, mas nunca sobrepor outro cliente ou intervalo de almoço. Horário da barbearia: {tz}.</p>
  <div className="space-y-3">
   <Field label="Serviço"><select className="input-dark" value={serviceId}
     onChange={e=>{const id=Number(e.target.value);setServiceId(id);
       const chosen=services.find(s=>s.service_id===id);
       setMinutes(String(Math.min(chosen?.duration_min??40,180)));}}>
     {services.map(s=><option value={s.service_id} key={s.service_id}>{s.name} — {s.duration_min} min</option>)}
   </select></Field>
   <div className="grid grid-cols-2 gap-2">
     <Field label="Dia"><Input type="date" value={date} onChange={e=>setDate(e.target.value)}/></Field>
     <Field label="Início"><Input type="time" step={300} value={startTime}
       onChange={e=>setStartTime(e.target.value)}/></Field>
   </div>
   <Field label="Duração do encaixe (minutos)"><Input type="number"
     inputMode="numeric" min={5} max={Math.min(180,svc?.duration_min??180)} step={5}
     value={minutes} onChange={e=>setMinutes(e.target.value)}/></Field>
   <Field label="Cliente"><Input value={name} onChange={e=>setName(e.target.value)} placeholder="Nome do cliente"/></Field>
   <Field label="WhatsApp do cliente"><Input type="tel" inputMode="tel"
     value={phone} onChange={e=>setPhone(e.target.value)} placeholder="(75) 99999-0000"/></Field>
   <p className="text-xs text-amber-200">Reserva manual, sem Pix automático. Só confirme com os dados fornecidos pelo cliente.</p>
   <Button className="w-full" disabled={!canSave||send.isPending} onClick={()=>send.mutate()}>
    {send.isPending?"Registrando…":"Confirmar encaixe"}
   </Button>
  </div>
 </Modal>;
}
