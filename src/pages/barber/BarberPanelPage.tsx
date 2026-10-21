import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarClock, CheckCircle2, Clock3, LogOut, Phone, Star, UserX } from "lucide-react";
import { clsx } from "clsx";
import { api, siteBase } from "@/lib/api";
import { useAuth, useConfig } from "@/lib/hooks";
import { NotificationsBell } from "@/components/layout/PanelLayout";
import { Badge, Button, EmptyState, Field, Input, Modal, Spinner, Textarea, useToast } from "@/components/ui";
import { fmtDayLong, fromMinutes, localDay, money, toMinutes } from "@/lib/format";

const DAY_NAMES = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];

export function BarberPanelPage() {
  const { data: cfg } = useConfig();
  const tz = cfg?.settings.timezone || "America/Bahia";
  const { logout } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState(0);
  const [blockOpen, setBlockOpen] = useState(false);

  const me = useQuery({ queryKey: ["barber-me", siteBase()], queryFn: () => api.get<any>("/barber/me") });
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
  const setStatus = useMutation({
    mutationFn: ({ id, status }: any) => api.patch(`/barber/bookings/${id}/status`, { status }),
    onSuccess: (_v, args) => { qc.invalidateQueries({ queryKey: ["barber-agenda"] }); qc.invalidateQueries({ queryKey: ["barber/notifications"] }); toast.push("ok", `Reserva marcada como ${args.status}.`); },
    onError: (e: any) => toast.push("err", e.message),
  });

  if (me.isLoading || agenda.isLoading) return <div className="grid min-h-screen place-items-center"><Spinner label="Abrindo sua agenda…" /></div>;
  const barber = me.data?.barber;
  const perms = me.data?.permissions;
  if (!barber) return <div className="grid min-h-screen place-items-center text-sm text-zinc-400">Usuário sem barbeiro vinculado — fale com o proprietário.</div>;

  const day = days[tab];
  const items = (agenda.data?.days?.[day] ?? []).filter((x: any) => x.status !== "cancelado");
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
            <button className="rounded-lg border border-line p-2 text-zinc-400 hover:text-red-300" onClick={() => logout.mutateAsync().then(() => navigate("/admin"))} aria-label="Sair"><LogOut size={16} /></button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-3xl space-y-4 px-4 py-6">
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
                    </div>
                    <Badge tone={it.status === "confirmado" ? "green" : it.status === "concluido" ? "gray" : it.status === "no_show" ? "red" : "amber"}>{it.status}</Badge>
                    {it.customer_phone && (
                      <a href={`https://wa.me/${String(it.customer_phone).replace(/\D/g, "").replace(/^(?!55)/, "55")}`} target="_blank" rel="noreferrer" className="rounded-lg border border-line p-1.5 text-zinc-400 hover:border-[var(--c-gold)] hover:text-[var(--c-gold)]" aria-label="WhatsApp do cliente"><Phone size={14} /></a>
                    )}
                    {["pendente", "confirmado"].includes(it.status) && (
                      <span className="flex gap-1.5">
                        {perms?.can_conclude && <Button size="sm" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: it.id, status: "concluido" })}><CheckCircle2 size={13} /> Concluir</Button>}
                        {perms?.can_conclude && <Button size="sm" variant="dark" disabled={setStatus.isPending} onClick={() => setStatus.mutate({ id: it.id, status: "no_show" })}><UserX size={13} /> Faltou</Button>}
                        {perms?.can_cancel && <Button size="sm" variant="danger" disabled={setStatus.isPending} onClick={() => { if (window.confirm("Cancelar este atendimento? O horário ficará disponível para outro cliente.")) setStatus.mutate({ id: it.id, status: "cancelado" }); }}>Cancelar</Button>}
                      </span>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </main>

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
