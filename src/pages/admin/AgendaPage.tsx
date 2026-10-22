import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Ban, CalendarX2, ChevronLeft, ChevronRight, Clock, Inbox, Link2, Plus, Search, User } from "lucide-react";
import { clsx } from "clsx";
import { api, siteBase } from "@/lib/api";
import { useConfig } from "@/lib/hooks";
import { Badge, Button, ConfirmDialog, Field, Input, Modal, Select, Spinner, Textarea, useToast } from "@/components/ui";
import { fmtDayLong, fromMinutes, localToUtcIso, money, toMinutes, utcToLocalParts } from "@/lib/format";

type View = "day" | "week" | "month";
const TONE: Record<string, any> = { pendente: "amber", confirmado: "green", concluido: "gray", cancelado: "red", no_show: "red", bloqueio: "blue" };

export function AgendaPage() {
  const { data: cfg } = useConfig();
  const tz = cfg?.settings.timezone || "America/Bahia";
  const qc = useQueryClient();
  const toast = useToast();
  const today = useMemo(() => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date()), [tz]);

  const [view, setView] = useState<View>("day");
  const [date, setDate] = useState(today);
  const [barberId, setBarberId] = useState<number | null>(null);
  const [search, setSearch] = useState("");
  const [openItem, setOpenItem] = useState<any | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const [manualOpen, setManualOpen] = useState(false);
  const [fitInPrefill,setFitInPrefill]=useState<{barberId:number;day:string;hhmm:string;availableMinutes:number}|null>(null);
  const [blockedOpen, setBlockedOpen] = useState(false);
  const [reqOpen, setReqOpen] = useState(false);

  const barbers = useQuery({ queryKey: ["admin-barbers", siteBase()], queryFn: () => api.get<any>("/admin/barbers").then((d) => d.barbers) });
  const agenda = useQuery({
    queryKey: ["agenda", siteBase(), view, date, barberId, search],
    queryFn: () => api.get<any>(`/admin/agenda?view=${view}&date=${date}${barberId ? `&barberId=${barberId}` : ""}${search ? `&q=${encodeURIComponent(search)}` : ""}`),
  });

  const shift = (n: number) => {
    const d = new Date(`${date}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + (view === "month" ? n * 30 - (new Date(`${date}T12:00:00Z`).getUTCDate() - 1) : n * (view === "week" ? 7 : 1)));
    if (view === "month") { const x = new Date(`${date}T12:00:00Z`); x.setUTCDate(1); x.setUTCMonth(x.getUTCMonth() + n); x.setUTCDate(15); setDate(x.toISOString().slice(0, 10)); return; }
    setDate(d.toISOString().slice(0, 10));
  };

  const invalidate = () => qc.invalidateQueries({ queryKey: ["agenda"] });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: any) => api.patch(`/admin/bookings/${id}/status`, { status }),
    onSuccess: () => { invalidate(); toast.push("ok", "Status atualizado."); },
    onError: (e: any) => toast.push("err", e.message),
  });

  return (
    <div className="space-y-4">
      {/* toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="mr-1 font-display text-2xl text-zinc-50">Agenda</h1>
        <div className="flex rounded-xl border border-line p-0.5">
          {(["day", "week", "month"] as View[]).map((v) => (
            <button key={v} onClick={() => setView(v)} className={clsx("rounded-lg px-3 py-1.5 text-xs font-semibold capitalize", view === v ? "bg-gold-soft text-[var(--c-gold)]" : "text-zinc-400")}>
              {v === "day" ? "Dia" : v === "week" ? "Semana" : "Mês"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button className="rounded-lg border border-line p-2 text-zinc-300 hover:border-[var(--c-gold)]" onClick={() => shift(-1)}><ChevronLeft size={15} /></button>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="input-dark w-auto px-2.5 py-1.5 text-sm" />
          <button className="rounded-lg border border-line p-2 text-zinc-300 hover:border-[var(--c-gold)]" onClick={() => shift(1)}><ChevronRight size={15} /></button>
          <button className="btn-ghost rounded-lg border px-2.5 py-1.5 text-xs text-zinc-300" onClick={() => setDate(today)}>hoje</button>
        </div>
        <Select value={barberId ?? ""} onChange={(e) => setBarberId(e.target.value ? Number(e.target.value) : null)} className="w-auto py-1.5 text-sm">
          <option value="">Todos os barbeiros</option>
          {(barbers.data ?? []).map((b: any) => <option key={b.id} value={b.id}>{b.name}{b.active ? "" : " (inativo)"}</option>)}
        </Select>
        <div className="relative min-w-[160px] flex-1">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="protocolo, nome ou telefone…" className="py-1.5 pl-8 text-sm" />
        </div>
        <Button size="sm" onClick={() => {setFitInPrefill(null);setManualOpen(true);}}><Plus size={14} /> Reserva manual / encaixe</Button>
        <Button size="sm" variant="dark" onClick={() => setBlockOpen(true)}><Ban size={14} /> Bloquear intervalo</Button>
        <Button size="sm" variant="dark" onClick={() => setBlockedOpen(true)}><CalendarX2 size={14} /> Folgas</Button>
        <Button size="sm" variant="dark" onClick={() => setReqOpen(true)}><Inbox size={14} /> Pedidos</Button>
      </div>

      {agenda.isLoading && <Spinner label="Lendo agenda no D1…" />}
      {agenda.error && <p className="text-sm text-red-300">Erro ao carregar agenda.</p>}

      {/* corpo */}
      {agenda.data && (
        <div className={clsx("grid gap-3", view === "week" && "grid-cols-1 md:grid-cols-7", view === "month" && "grid-cols-2 md:grid-cols-7")}>
          {agenda.data.days.map((day: any) => {
            const totalItems = day.barbers.reduce((a: number, b: any) => a + b.items.length, 0);
            if (view === "month") {
              return (
                <button key={day.date} onClick={() => { setDate(day.date); setView("day"); }} className={clsx("min-h-[86px] rounded-xl border p-2 text-left transition-colors hover:border-[var(--c-gold)]", day.date === today ? "border-[var(--c-gold)]/50 bg-gold-soft" : "border-line bg-panel")}>
                  <p className={clsx("text-xs font-bold", day.date === today ? "text-[var(--c-gold)]" : "text-zinc-400")}>{day.date.slice(8)}</p>
                  <p className="mt-1 text-2xl leading-none text-zinc-100">{totalItems || ""}</p>
                  {day.blocked?.length > 0 && <Badge tone="blue"><Ban size={10} /> fechado</Badge>}
                  {totalItems > 0 && <p className="mt-1 text-[10px] text-zinc-500">{day.barbers.length} prof.</p>}
                </button>
              );
            }
            return (
              <section key={day.date} className="rounded-2xl border border-line bg-panel p-3">
                <header className="mb-2 flex items-baseline justify-between">
                  <h2 className={clsx("font-display text-sm", day.date === today ? "text-[var(--c-gold)]" : "text-zinc-200")}>{fmtDayLong(day.date)}</h2>
                  <span className="text-[11px] text-zinc-500">{totalItems} reserva(s)</span>
                </header>
                {day.blocked?.length > 0 && (
                  <p className="mb-2 rounded-lg border border-sky-500/30 bg-sky-500/5 px-2 py-1 text-[11px] text-sky-300">
                    <Ban size={11} className="mr-1 inline" /> {day.blocked.map((b: any) => `${b.barber_name ?? "Geral"}: ${b.kind}${b.reason ? ` — ${b.reason}` : ""}`).join(" · ")}
                  </p>
                )}
                <div className={clsx("grid gap-2", view === "day" && "sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4")}>
                  {day.barbers.map((col: any) => (
                    <div key={col.barber_id} className="rounded-xl border border-line bg-ink-soft p-2">
                      <p className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold text-zinc-300">
                        <img src={col.photo} alt="" className="h-[18px] w-[18px] rounded-full object-cover" onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
                        {col.name} <span className="text-zinc-600">({col.items.length})</span>
                      </p>
                      <ul className="space-y-1">
                        {col.items.map((it: any) => (
                          <li key={it.id}>
                            <button onClick={() => setOpenItem(it)} className={clsx("w-full rounded-lg border-l-2 px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-ink-soft",
                              it.status === "bloqueio" ? "border-sky-500 bg-sky-500/5" : it.status === "cancelado" ? "border-red-500/60 opacity-60" : it.status === "concluido" ? "border-zinc-500 opacity-75" : "border-[var(--c-gold)] bg-gold-soft")}>
                              <span className="flex items-center justify-between gap-1">
                                <b className={clsx("font-mono text-[11px]", it.status === "bloqueio" ? "text-sky-300" : "text-[var(--c-gold)]")}>{it.label}</b>
                                <Badge tone={TONE[it.status] || "gray"}>{it.status === "bloqueio" ? "bloqueio" : it.status}</Badge>
                              </span>
                              <span className="block truncate text-zinc-200">{it.status === "bloqueio" ? it.notes || "Bloqueio" : it.customer_name}</span>
                              {it.status !== "bloqueio" && <span className="block truncate text-[10.5px] text-zinc-500">{it.service_name} · {money(it.price_cents)}</span>}
                            </button>
                          </li>
                        ))}
                        {col.items.length === 0 && <li className="rounded-lg border border-dashed border-line px-2 py-3 text-center text-[11px] text-zinc-600">livre o dia</li>}
                      </ul>
                    </div>
                  ))}
                  {day.barbers.length === 0 && <p className="col-span-full py-3 text-center text-xs text-zinc-600">Sem reservas neste {view === "week" ? "dia" : "período"}.{day.blocked?.length ? " (dia bloqueado)" : ""}</p>}
                </div>
              </section>
            );
          })}
        </div>
      )}

      {openItem && <BookingModal item={openItem} onClose={() => setOpenItem(null)} tz={tz}
        onChanged={() => { setOpenItem(null); invalidate(); }}
        onFitIn={(releasedFrom:string,minutes:number,barberId:number)=>{
          const local=utcToLocalParts(tz,releasedFrom);
          setFitInPrefill({barberId,day:local.day,hhmm:local.hhmm,availableMinutes:minutes});
          setOpenItem(null);invalidate();setManualOpen(true);
        }}/>}

      {blockOpen && <BlockModal barbers={barbers.data ?? []} onClose={() => setBlockOpen(false)} onDone={() => { setBlockOpen(false); invalidate(); }} />}
      {manualOpen && <ManualModal barbers={barbers.data ?? []} prefill={fitInPrefill} onClose={() => setManualOpen(false)} onDone={() => { setManualOpen(false); invalidate(); }} />}
      {blockedOpen && <BlockedDaysModal barbers={barbers.data ?? []} onClose={() => setBlockedOpen(false)} onChanged={invalidate} />}
      {reqOpen && <BlockRequestsModal onClose={() => setReqOpen(false)} onDone={() => { setReqOpen(false); invalidate(); }} />}
    </div>
  );
}

/* ── detalhe da reserva (usa o item já carregado pela agenda) ────────────── */
function BookingModal({ item: b, onClose, onChanged, onFitIn, tz }: any) {
  const toast = useToast();
  const id = b.id as number;
  const [busy, setBusy] = useState(false);
  const [resched, setResched] = useState<{ day: string; hhmm: string } | null>(null);

  const finishEarly = async () => {
    try {
      setBusy(true);
      const result=await api.post<{releasedFrom:string;minutesAvailable:number}>(
        `/admin/bookings/${id}/finish-early`,{}
      );
      toast.push("ok",`Atendimento concluído. ${result.minutesAvailable} min liberados para encaixe.`);
      onFitIn(result.releasedFrom,result.minutesAvailable,b.barber_id);
    } catch(e:any){toast.push("err",e.message);}
    finally{setBusy(false);}
  };
  const patch = async (status: string) => {
    try { setBusy(true); await api.patch(`/admin/bookings/${id}/status`, { status }); toast.push("ok", `Status: ${status}.`); onChanged(); }
    catch (e: any) { toast.push("err", e.message); }
    finally { setBusy(false); }
  };
  const doResched = async () => {
    try {
      setBusy(true);
      const startsAt = localToUtcIso(tz, resched!.day, resched!.hhmm);
      await api.post(`/admin/bookings/${id}/reschedule`, { startsAt });
      toast.push("ok", "Remarcado (conflitos revalidados pelo servidor).");
      onChanged();
    } catch (e: any) { toast.push("err", e.message); }
    finally { setBusy(false); }
  };

  return (
    <Modal open onClose={onClose} title="Reserva">
      {
        <div className="space-y-3 text-sm">
          <div className="flex items-center justify-between">
            <p className="font-mono text-[13px] text-[var(--c-gold)]">{b.code}</p>
            <Badge tone={TONE[b.status] || "gray"}>{b.status}</Badge>
          </div>
          <p className="text-zinc-200">{b.service_name} <span className="text-zinc-500">({b.duration_min} min)</span> com <b className="text-zinc-100">{b.barber_name}</b></p>
          <p className="text-zinc-300">{new Date(b.starts_at).toLocaleString("pt-BR", { timeZone: tz })} → {new Date(b.ends_at).toLocaleString("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" })}</p>
          <p className="text-xs text-zinc-400">Pagamento: <b className="text-zinc-200">
            {b.payment_choice === "pix"
              ? b.payment_status === "paid" ? "Pix confirmado" :
                b.payment_status === "refund_required" ? "Estorno pendente" :
                b.payment_status === "pending" ? "Pix aguardando pagamento" : "Pix não confirmado"
              : "Após o atendimento"}
          </b> · {money(b.price_cents)}</p>
          <div className="rounded-xl border border-line bg-ink-soft p-3 text-[13px]">
            <p className="flex items-center gap-1.5 text-zinc-200"><User size={13} className="text-zinc-500" /> {b.customer_name}</p>
            {b.customer_phone && <a className="flex items-center gap-1.5 text-[var(--c-gold)]" href={`https://wa.me/${b.customer_phone.replace(/\D/g, "").replace(/^(?!55)/, "55")}`} target="_blank" rel="noreferrer"><Link2 size={13} /> {b.customer_phone} (WhatsApp)</a>}
            {b.notes && <p className="mt-1.5 text-zinc-400">Obs.: {b.notes}</p>}
          </div>
          {b.status !== "bloqueio" && (
            <div className="flex flex-wrap gap-2 pt-1">
              
              {["pendente", "confirmado"].includes(b.status) && <Button size="sm" variant="dark" disabled={busy} onClick={() => patch("concluido")}>Concluir</Button>}
              {["pendente","confirmado"].includes(b.status) &&
                Date.now()>=Date.parse(b.starts_at) && Date.now()+300000<Date.parse(b.ends_at) && (
                <Button size="sm" disabled={busy} onClick={finishEarly}>
                  Concluir antecipadamente e encaixar
                </Button>
              )}
              {["pendente", "confirmado"].includes(b.status) && <Button size="sm" variant="dark" disabled={busy} onClick={() => patch("no_show")}>No-show</Button>}
              {["pendente", "confirmado"].includes(b.status) && <Button size="sm" variant="danger" disabled={busy} onClick={() => patch("cancelado")}>Cancelar</Button>}
              {["pendente", "confirmado"].includes(b.status) && !resched && (
                <Button size="sm" variant="ghost" onClick={() => { const p = utcToLocalParts(tz, b.starts_at); setResched(p); }}>Remarcar…</Button>
              )}
            </div>
          )}
          {resched && (
            <div className="rounded-xl border border-[color-mix(in_srgb,var(--c-gold)_40%,transparent)] bg-gold-soft p-3">
              <p className="mb-2 text-[13px] font-semibold text-zinc-100">Nova data/hora local do barbeiro</p>
              <div className="flex gap-2">
                <Input type="date" value={resched.day} onChange={(e) => setResched({ ...resched, day: e.target.value })} />
                <Input type="time" step={300} value={resched.hhmm} onChange={(e) => setResched({ ...resched, hhmm: e.target.value })} className="w-32" />
                <Button size="sm" disabled={busy} onClick={doResched}>Salvar</Button>
                <Button size="sm" variant="ghost" onClick={() => setResched(null)}>×</Button>
              </div>
              <p className="mt-1.5 text-[11px] text-zinc-500">O servidor revalida expediente, folgas, feriados, conflitos e antecedência — se algo colidir, a remarcação é recusada.</p>
            </div>
          )}
          {b.status === "bloqueio" && (
            <Button variant="danger" size="sm" disabled={busy} onClick={() => patch("cancelado")}>Remover bloqueio (cancelar)</Button>
          )}
        </div>
      }
    </Modal>
  );
}

/* ── pedidos de bloqueio dos barbeiros ───────────────────────────────────── */
function BlockRequestsModal({ onClose, onDone }: any) {
  const toast = useToast();
  const qc = useQueryClient();
  const [acting, setActing] = useState<number | null>(null);
  const q = useQuery({ queryKey: ["block-requests", siteBase()], queryFn: () => api.get<any>("/admin/block-requests") });
  const act = async (id: number, ok: boolean) => {
    if (acting !== null) return;
    setActing(id);
    try {
      const r = await api.post<any>(`/admin/block-requests/${id}/${ok ? "approve" : "reject"}`, {});
      toast.push("ok", r.message || (ok ? "Bloqueio aplicado à agenda." : "Pedido recusado."));
      qc.invalidateQueries({ queryKey: ["block-requests"] });
      onDone();
    } catch (e: any) { toast.push("err", e.message); }
    finally { setActing(null); }
  };
  return (
    <Modal open onClose={onClose} title="Pedidos de bloqueio dos barbeiros" wide>
      {q.isLoading ? <Spinner /> : q.isError ? (
        <div role="alert" className="rounded-xl border border-amber-500/40 p-4 text-sm text-amber-200">
          Não foi possível carregar os pedidos.
          <button className="ml-2 underline" onClick={() => void q.refetch()}>Tentar novamente</button>
        </div>
      ) : (
        <ul className="space-y-2">
          {(q.data?.requests ?? []).map((r: any) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-ink-soft px-3 py-2.5 text-sm">
              <b className="text-zinc-100">{r.barber_name}</b>
              <span className="text-zinc-400">{r.date} · {fromMinutes(r.start_min)}–{fromMinutes(r.end_min)}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-500">{r.reason}</span>
              {r.status === "pendente" ? (
                <span className="flex gap-1.5">
                  <Button size="sm" disabled={acting !== null} onClick={() => void act(r.id, true)}>Aprovar</Button>
                  <Button size="sm" variant="danger" disabled={acting !== null} onClick={() => void act(r.id, false)}>Recusar</Button>
                </span>
              ) : <Badge tone={r.status === "aprovado" ? "green" : "red"}>{r.status}</Badge>}
            </li>
          ))}
          {!q.data?.requests?.length && <p className="py-5 text-center text-xs text-zinc-600">Nenhum pedido pendente.</p>}
        </ul>
      )}
    </Modal>
  );
}

/* ── criar reserva manual ────────────────────────────────────────────────── */
function ManualModal({ barbers, onClose, onDone, prefill }: any) {
  const toast = useToast();
  const [f, setF] = useState({ barberId: prefill?.barberId ?? barbers[0]?.id ?? 0,
    serviceId: 0, day: prefill?.day ?? new Date().toISOString().slice(0, 10),
    hhmm: prefill?.hhmm ?? "09:00", name: "", phone: "", notes: "", status: "confirmado" });
  const [quick,setQuick]=useState(Boolean(prefill));
  const [quickMinutes,setQuickMinutes]=useState(Math.min(180,prefill?.availableMinutes??15));
  const services = useQuery({ queryKey: ["admin-services", siteBase()], queryFn: () => api.get<any>("/admin/services").then((d: any) => d.services.filter((s: any) => s.active)) });
  const { data: cfg } = useConfig();
  const tz = cfg?.settings.timezone || "America/Bahia";
  const create = async () => {
    try {
      const res = await api.post("/admin/bookings", {
        barberId: f.barberId, serviceId: f.serviceId, name: f.name, phone: f.phone.replace(/\D/g, ""),
        notes: f.notes, status: f.status, notify: true,
        startsAt: localToUtcIso(tz, f.day, f.hhmm),
        ...(quick?{fitInDurationMin:quickMinutes}:{})
      });
      toast.push("ok", `Reserva ${res.code} criada.`);
      onDone();
    } catch (e: any) { toast.push("err", e.message); }
  };
  return (
    <Modal open onClose={onClose} title="Reserva manual (telefone, balcão, WhatsApp)">
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Barbeiro"><Select value={f.barberId} onChange={(e) => setF({ ...f, barberId: Number(e.target.value) })}>{barbers.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
          <Field label="Serviço"><Select value={f.serviceId} onChange={(e) => setF({ ...f, serviceId: Number(e.target.value) })}><option value={0}>selecione…</option>{(services.data ?? []).map((s: any) => <option key={s.id} value={s.id}>{s.name} · {money(s.price_cents)}</option>)}</Select></Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Data"><Input type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></Field>
          <Field label="Hora local"><Input type="time" step={300} value={f.hhmm} onChange={(e) => setF({ ...f, hhmm: e.target.value })} /></Field>
        </div>
        <label className="flex items-center gap-2 rounded-lg border border-line bg-ink-soft px-3 py-2 text-sm text-zinc-200">
          <input type="checkbox" checked={quick} onChange={e=>setQuick(e.target.checked)}/>
          Encaixe rápido fora da grade de 30 minutos
        </label>
        {quick && <div className="space-y-2 rounded-lg border border-[var(--c-gold)]/30 bg-gold-soft p-3">
          <Field label="Duração do encaixe (minutos, de 5 em 5)">
            <Input type="number" min={5} max={prefill?.availableMinutes??180} step={5}
              value={quickMinutes} onChange={e=>setQuickMinutes(Number(e.target.value))}/>
          </Field>
          <p className="text-xs text-zinc-400">
            O tempo reduzido precisa ser suficiente para realizar o serviço.
            O preço é o cadastrado; o servidor valida horários livres, folgas e colisões.
            {prefill?` Foram liberados ${prefill.availableMinutes} minutos.`:""}
          </p>
        </div>}
        <Field label="Cliente" required><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="nome" /></Field>
        <Field label="Telefone/WhatsApp"><Input value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} placeholder="(75) 9…" /></Field>
        <Field label="Observações"><Textarea value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <Button className="w-full justify-center" disabled={!f.name || !f.serviceId || !f.barberId || (quick && (!Number.isInteger(quickMinutes)||quickMinutes<5||quickMinutes%5!==0||(prefill&&quickMinutes>prefill.availableMinutes)))} onClick={create}>Criar na agenda (regras validadas no servidor)</Button>
      </div>
    </Modal>
  );
}

/* ── bloquear intervalo na grade ─────────────────────────────────────────── */
function BlockModal({ barbers, onClose, onDone, tz }: any) {
  const toast = useToast();
  const [f, setF] = useState({ barberId: barbers[0]?.id ?? 0, day: new Date().toISOString().slice(0, 10), from: "13:00", to: "14:00", reason: "Almoço estendido" });
  const create = async () => {
    try {
      const res = await api.post("/admin/blocks", { barberId: f.barberId, date: f.day, startMin: toMinutes(f.from), endMin: toMinutes(f.to), reason: f.reason });
      toast.push("ok", `Bloqueio ${res.code} aplicado.`);
      onDone();
    } catch (e: any) { toast.push("err", e.message); }
  };
  return (
    <Modal open onClose={onClose} title="Bloquear intervalo de agenda">
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-zinc-500">Cria um “bloqueio” na grade do profissional — os slots ficam indisponíveis no site. Se houver clientes no intervalo, o servidor recusa com 409.</p>
        <Field label="Barbeiro"><Select value={f.barberId} onChange={(e) => setF({ ...f, barberId: Number(e.target.value) })}>{barbers.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}</Select></Field>
        <div className="grid grid-cols-3 gap-3">
          <Field label="Data"><Input type="date" value={f.day} onChange={(e) => setF({ ...f, day: e.target.value })} /></Field>
          <Field label="Início"><Input type="time" step={300} value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></Field>
          <Field label="Fim"><Input type="time" step={300} value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></Field>
        </div>
        <Field label="Motivo"><Input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
        <Button className="w-full justify-center" onClick={create}>Bloquear {f.from}–{f.to}</Button>
      </div>
    </Modal>
  );
}

/* ── folgas/férias/feriados ─────────────────────────────────────────────── */
function BlockedDaysModal({ barbers, onClose, onChanged }: any) {
  const toast = useToast();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["blocked-days", siteBase()], queryFn: () => api.get<any>("/admin/blocked-days") });
  const [f, setF] = useState({ barberId: "" as string | number, dateFrom: new Date().toISOString().slice(0, 10), dateTo: new Date().toISOString().slice(0, 10), kind: "day_off", reason: "" });
  const create = async () => {
    try {
      await api.post("/admin/blocked-days", { barberId: f.barberId === "" ? null : Number(f.barberId), dateFrom: f.dateFrom, dateTo: f.dateTo, kind: f.kind, reason: f.reason });
      toast.push("ok", "Bloqueio de dia criado — a disponibilidade some do site nesse período.");
      qc.invalidateQueries({ queryKey: ["blocked-days"] });
      onChanged();
    } catch (e: any) { toast.push("err", e.message); }
  };
  const remove = async (id: number) => {
    await api.del(`/admin/blocked-days/${id}`);
    qc.invalidateQueries({ queryKey: ["blocked-days"] });
    onChanged();
  };
  return (
    <Modal open onClose={onClose} title="Folgas · férias · feriados" wide>
      <div className="mb-4 grid gap-2 rounded-xl border border-line bg-ink-soft p-3 sm:grid-cols-6">
        <Select className="sm:col-span-1" value={f.barberId} onChange={(e) => setF({ ...f, barberId: e.target.value })}>
          <option value="">Todos (geral)</option>
          {barbers.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
        <Input type="date" value={f.dateFrom} onChange={(e) => setF({ ...f, dateFrom: e.target.value })} />
        <Input type="date" value={f.dateTo} onChange={(e) => setF({ ...f, dateTo: e.target.value })} />
        <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          <option value="day_off">Folga</option><option value="vacation">Férias</option><option value="holiday">Feriado</option><option value="other">Outro</option>
        </Select>
        <Input placeholder="motivo (opcional)" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <Button onClick={create} className="justify-center">Adicionar</Button>
      </div>
      {q.isLoading ? <Spinner /> : (
        <ul className="space-y-1.5">
          {(q.data?.blocked ?? []).map((b: any) => (
            <li key={b.id} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-[13px]">
              <Clock size={13} className="text-zinc-500" />
              <b className="text-zinc-200">{b.barber_id ? barbers.find((x: any) => x.id === b.barber_id)?.name ?? `#${b.barber_id}` : "⚑ Geral (barbearia)"}</b>
              <span className="text-zinc-400">{b.date_from}{b.date_to !== b.date_from ? ` → ${b.date_to}` : ""}</span>
              <Badge tone="blue">{b.kind}</Badge>
              <span className="min-w-0 flex-1 truncate text-zinc-500">{b.reason}</span>
              <button className="text-zinc-500 hover:text-red-400" onClick={() => remove(b.id)}><CalendarX2 size={15} /></button>
            </li>
          ))}
          {!q.data?.blocked?.length && <p className="py-4 text-center text-xs text-zinc-600">Nenhum dia bloqueado.</p>}
        </ul>
      )}
    </Modal>
  );
}
