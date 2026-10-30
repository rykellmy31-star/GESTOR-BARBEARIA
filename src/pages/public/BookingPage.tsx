import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, ChevronLeft, Clock, Loader2, Scissors, ShieldCheck, Star, UserRound, CalendarCheck2, MessageCircle, AlertTriangle } from "lucide-react";
import { clsx } from "clsx";
import { api, siteBase } from "@/lib/api";
import { useConfig } from "@/lib/hooks";
import { Badge, Button, Field, Input, Spinner, Textarea, useToast } from "@/components/ui";
import { fmtDayLong, localDay, maskPhone, money, wizardKey, weekdayShort, MONTHS } from "@/lib/format";
import type { Barber, Service } from "@/lib/types";

const STEPS = ["Serviço", "Barbeiro", "Data", "Horário", "Você", "Confirmar"];

export function BookingPage() {
  const { data: cfg } = useConfig();
  const tz = cfg?.settings.timezone || "America/Bahia";
  const [params] = useSearchParams();
  const toast = useToast();
  const navigate = useNavigate();

  const [step, setStep] = useState(params.get("servico") ? 1 : 0);
  const [serviceId, setServiceId] = useState<number | null>(params.get("servico") ? Number(params.get("servico")) : null);
  const [barberId, setBarberId] = useState<number | null>(params.get("barbeiro") ? Number(params.get("barbeiro")) : null);
  const [date, setDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<{ t: string; label: string } | null>(null);
  const [form, setForm] = useState({ name: "", phone: "", email: "", notes: "", consent: false, whatsappOptin: false });
  const [confirming, setConfirming] = useState(false);
  const [paymentChoice,setPaymentChoice]=useState<"after_service"|"pix">("after_service");
  const [done, setDone] = useState<any | null>(null);
  const [idk] = useState(wizardKey());

  const services = useQuery({ queryKey: ["tenant", siteBase(), "services"], queryFn: () => api.get<{ services: Service[] }>("/services").then((d) => d.services) });
  const barbers = useQuery({ queryKey: ["tenant", siteBase(), "barbers"], queryFn: () => api.get<{ barbers: Barber[] }>("/barbers").then((d) => d.barbers) });
  const service = services.data?.find((x) => x.id === serviceId) ?? null;
  const barberProfile = useQuery({
    queryKey: ["tenant", siteBase(), "barber-profile", barberId],
    queryFn: () => api.get<any>(`/barbers/${barberId}`),
    enabled: Boolean(barberId),
  });
  const availability = useQuery({
    queryKey: ["tenant", siteBase(), "availability", barberId, serviceId, date],
    queryFn: () => api.get<{ ok: boolean; closed_reason?: string; slots: { t: string; label: string }[] }>(`/availability?barberId=${barberId}&serviceId=${serviceId}&date=${date}`),
    enabled: Boolean(barberId && serviceId && date),
  });

  // barbeiros que fazem o serviço
  const eligible = useMemo(() => (services.data && barbers.data ? barbers.data.filter((b) => services.data.find((sv2: Service) => sv2.id === serviceId)?.barber_ids?.includes(b.id)) : undefined), [barbers.data, services.data, serviceId]);

  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, [step]);

  // se trocar serviço e o barbeiro atual não o atende, limpa seleção
  useEffect(() => {
    if (barberId && eligible && !eligible.some((b) => b.id === barberId)) setBarberId(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);
  useEffect(() => { setSlot(null); }, [date, barberId, serviceId]);

  const canNext = [Boolean(service), Boolean(barberId), Boolean(date), Boolean(slot), form.name.trim().length >= 2 && form.phone.replace(/\D/g, "").length >= 10 && form.consent, true][step];

  const confirm = async () => {
    try {
      setConfirming(true);
      const res = await api.post("/bookings", {
        serviceId, barberId, startsAt: slot!.t,
        name: form.name.trim(), phone: form.phone.replace(/\D/g, ""), email: form.email.trim() || "",
        notes: form.notes.trim(), consent: true, whatsappOptin: form.whatsappOptin, idempotencyKey: idk, paymentChoice,
      });
      setDone(res);
      localStorage.setItem(`tigu_token_${res.booking.code}`, String(res.cancel_token));
      // Dados somente do tenant atual, para consulta imediata da própria reserva.
      localStorage.setItem(`tigu_last_code:${siteBase()}`, res.booking.code);
      localStorage.setItem(`tigu_last_phone:${siteBase()}`, form.phone.replace(/\D/g, ""));
    } catch (e: any) {
      toast.push("err", e.message);
      if (e.status === 409) {
        // horário foi tomado — volta para escolher outro
        availability.refetch();
        setStep(3);
      }
    } finally {
      setConfirming(false);
    }
  };

  if (done) return <SuccessScreen done={done} settings={cfg?.settings} navigate={navigate} />;

  return (
    <div className="mx-auto min-h-screen max-w-3xl px-4 pb-24 pt-24">
      {/* stepper */}
      <div className="mb-8">
        <h1 className="mb-1 flex items-center gap-2 font-display text-3xl text-zinc-50"><Scissors className="text-[var(--c-gold)]" /> Agendamento</h1>
        <div className="mt-4 flex items-center">
          {STEPS.map((label, i) => (
            <div key={label} className="flex flex-1 items-center last:flex-none">
              <button
                onClick={() => i < step && setStep(i)}
                className={clsx("flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-[11px] font-bold transition-all", i < step ? "border-[var(--c-gold)] bg-gold-soft text-[var(--c-gold)]" : i === step ? "border-[var(--c-gold)] bg-[var(--c-gold)] text-black" : "border-line text-zinc-600")}
                disabled={i > step}
                aria-label={label}
              >
                {i < step ? <CheckCircle2 size={15} /> : i + 1}
              </button>
              <span className={clsx("ml-2 hidden text-[11px] uppercase tracking-wider sm:block", i === step ? "text-[var(--c-gold)]" : "text-zinc-600")}>{label}</span>
              {i < STEPS.length - 1 && <div className={clsx("mx-2 h-px flex-1", i < step ? "bg-[var(--c-gold)]/60" : "bg-line")} />}
            </div>
          ))}
        </div>
      </div>

      <div className="step-enter" key={step}>
        {step === 0 && (
          <Grid title="1. Escolha o serviço">
            {services.isLoading && <Spinner />}
            {services.data?.map((sv) => (
              <ChoiceCard key={sv.id} selected={serviceId === sv.id} onClick={() => { setServiceId(sv.id); setStep(1); }}>
                <img src={sv.photo} alt="" className="h-24 w-full rounded-t-2xl object-cover" loading="lazy" />
                <div className="p-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-sm font-semibold leading-snug text-zinc-100">{sv.name}</p>
                    <p className="whitespace-nowrap text-sm font-bold text-[var(--c-gold)]">{money(sv.price_cents)}</p>
                  </div>
                  <p className="mt-1 flex items-center gap-1 text-[11px] text-zinc-500"><Clock size={12} /> {sv.duration_min} min · {sv.category}</p>
                </div>
              </ChoiceCard>
            ))}
          </Grid>
        )}

        {step === 1 && (
          <Grid title="2. Escolha seu barbeiro" subtitle={service ? `Profissionais que realizam: ${service.name}` : undefined}>
            {eligible?.map((b) => (
              <div key={b.id}>
                <ChoiceCard selected={barberId === b.id} onClick={() => { setBarberId(b.id); }}>
                  <div className="flex items-center gap-3.5 p-3.5">
                    <img src={b.photo} alt={b.name} className="h-14 w-14 rounded-xl object-cover" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-zinc-100">{b.name}</p>
                      <p className="truncate text-xs text-[var(--c-gold)]">{b.specialty}</p>
                      <p className="mt-0.5 flex items-center gap-1 text-[11px] text-zinc-500"><Star size={11} className="fill-current text-[var(--c-gold)]" /> {b.rating.toFixed(1)} · {b.reviews_count} avaliações</p>
                    </div>
                    {barberId === b.id && <CheckCircle2 size={18} className="shrink-0 text-[var(--c-gold)]" />}
                  </div>
                </ChoiceCard>
                {barberId === b.id && barberProfile.data && <BarberProfile data={barberProfile.data} tz={tz} />}
              </div>
            ))}
            {eligible && eligible.length === 0 && <p className="col-span-full text-sm text-zinc-500">Nenhum profissional disponível para este serviço. Tente outro serviço.</p>}
            {barberId && (
              <div className="col-span-full mt-2 flex justify-between">
                <BackBtn onClick={() => setStep(0)} />
                <Button onClick={() => setStep(2)}>Escolher data →</Button>
              </div>
            )}
          </Grid>
        )}

        {step === 2 && <DateStep tz={tz} barberId={barberId!} serviceId={serviceId!} date={date} setDate={(d: string) => { setDate(d); setStep(3); }} horizon={cfg?.settings.horizon_days ?? 30} onBack={() => setStep(1)} />}

        {step === 3 && (
          <div>
            <p className="mb-1 font-display text-lg text-zinc-100">4. Horário de {date && fmtDayLong(date)}</p>
            <p className="mb-5 text-xs text-zinc-500">
              {service?.duration_min} min com {barberId && ` ${barberProfile.data?.barber?.name}`} · somente horários realmente livres
              {cfg?.settings.min_lead_min ? ` · antecedência mínima de ${cfg.settings.min_lead_min} min para hoje` : ""}
            </p>
            {availability.isLoading ? <Spinner label="Consultando disponibilidade no servidor…" /> : !availability.data?.ok ? (
              <div className="rounded-2xl border border-amber-500/30 bg-amber-500/5 p-6 text-center">
                <AlertTriangle size={26} className="mx-auto mb-2 text-amber-400" />
                <p className="text-sm text-amber-200">{{
                  dia_off: "O profissional não trabalha neste dia (folga, férias ou feriado).",
                  barbearia_fechada: "A barbearia está fechada neste dia.",
                  barbeiro_inativo: "Este profissional está indisponível no momento.",
                  fora_intervalo: "Sem horários neste dia.",
                }[availability.data?.closed_reason as string] ?? "Sem horários neste dia."}</p>
              </div>
            ) : availability.data.slots.length === 0 ? (
              <div className="rounded-2xl border border-line p-6 text-center text-sm text-zinc-400">
                Agenda cheia neste dia! 😅 Tente outra data ou fale no WhatsApp para a lista de espera.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {availability.data.slots.map((s) => (
                    <button key={s.t} onClick={() => setSlot(s)} className={clsx("rounded-xl border py-2.5 text-sm font-semibold transition-all", slot?.t === s.t ? "border-[var(--c-gold)] bg-gold-soft text-[var(--c-gold)]" : "border-line bg-panel text-zinc-200 hover:border-[var(--c-gold)]/60")}>
                      {s.label}
                    </button>
                  ))}
                </div>
                <div className="mt-5 flex justify-between">
                  <BackBtn onClick={() => setStep(2)} />
                  <Button disabled={!slot} onClick={() => setStep(4)}>Continuar →</Button>
                </div>
              </>
            )}
            {availability.isError && <p className="mt-3 text-sm text-red-300">Erro ao consultar horários. <button className="underline" onClick={() => availability.refetch()}>Tentar novamente</button></p>}
          </div>
        )}

        {step === 4 && (
          <div className="mx-auto max-w-md space-y-4">
            <p className="font-display text-lg text-zinc-100">5. Seus dados</p>
            <Field label="Nome completo" required><Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Como você quer ser atendido(a)" /></Field>
            <Field label="WhatsApp" required hint="É assim que a barbearia fala com você"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: maskPhone(e.target.value) })} placeholder="(75) 99999-0000" inputMode="tel" /></Field>
            <Field label="E-mail (opcional)"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="para comprovante" /></Field>
            <Field label="Observações"><Textarea value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Ex.: prefiro tesoura na parte de cima, alergia a determinado produto…" /></Field>
            <label className="flex items-start gap-2.5 rounded-xl border border-line bg-ink-soft p-3.5 text-[12.5px] leading-relaxed text-zinc-400">
              <input type="checkbox" checked={form.consent} onChange={(e) => setForm({ ...form, consent: e.target.checked })} className="mt-0.5 h-4 w-4 accent-[var(--c-gold)]" />
              <span><ShieldCheck size={13} className="mr-1 inline text-[var(--c-gold)]" /> Autorizo o uso dos meus dados para gestão do agendamento, conforme a <b className="text-zinc-300">LGPD</b>. Você pode solicitar a exclusão a qualquer momento pela barbearia.</span>
            </label>
            <label className="flex cursor-pointer items-start gap-2.5 rounded-xl border border-[var(--c-gold)]/30 bg-gold-soft p-3.5 text-[12.5px] leading-relaxed text-zinc-200">
              <input type="checkbox" checked={form.whatsappOptin}
                onChange={(e) => setForm({ ...form, whatsappOptin: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-[var(--c-gold)]" />
              <span>
                <MessageCircle size={14} className="mr-1 inline text-[var(--c-gold)]" />
                <strong>Quero receber a confirmação e os lembretes deste agendamento pelo WhatsApp.</strong>
                <span className="mt-1 block text-xs text-zinc-400">
                  Avisos de horário, confirmação e link para reagendar. Opcional; seu agendamento funciona mesmo sem marcar.
                </span>
              </span>
            </label>
            <div className="flex justify-between pt-1">
              <BackBtn onClick={() => setStep(3)} />
              <Button disabled={!canNext} onClick={() => setStep(5)}>Revisar agendamento →</Button>
            </div>
          </div>
        )}

        {step === 5 && service && barberProfile.data?.barber && (
          <div className="mx-auto max-w-md">
            <p className="mb-4 font-display text-lg text-zinc-100">6. Confirme seu horário</p>
            <div className="overflow-hidden rounded-2xl border border-[color-mix(in_srgb,var(--c-gold)_40%,transparent)] bg-panel shadow-gold">
              <img src={barberProfile.data.barber.photo} alt="" className="h-36 w-full object-cover object-top opacity-90" />
              <div className="space-y-2.5 p-5 text-sm">
                <Row icon={<Scissors size={15} />} k="Serviço" v={service.name} />
                <Row icon={<UserRound size={15} />} k="Profissional" v={barberProfile.data.barber.name} />
                <Row icon={<CalendarDays size={15} />} k="Data & hora" v={`${date && fmtDayLong(date)} · ${slot?.label} (horário local)`} />
                <Row icon={<Clock size={15} />} k="Duração" v={`${barberProfile.data?.service_durations?.[service.id] ?? service.duration_min} min`} />
                <div className="gold-hr !my-3" />
                <div className="flex items-center justify-between">
                  <span className="text-zinc-400">Valor</span>
                  <span className="font-display text-2xl font-semibold text-[var(--c-gold)]">{money(service.price_cents)}</span>
                </div>
                {cfg?.settings.cancel_policy_text && <p className="pt-1 text-[11.5px] leading-relaxed text-zinc-500">{cfg.settings.cancel_policy_text}</p>}
              </div>
            </div>

            <div className="mt-5 space-y-2" role="radiogroup" aria-label="Forma de pagamento">
              <p className="text-sm font-semibold text-zinc-100">Como deseja pagar?</p>
              <label className="flex cursor-pointer gap-3 rounded-xl border border-line bg-panel p-3 text-sm text-zinc-100">
                <input type="radio" name="paychoice" checked={paymentChoice==="after_service"} onChange={()=>setPaymentChoice("after_service")} />
                <span><b>Pagar após o serviço</b><span className="block text-xs text-zinc-400">Reserve agora, pague no atendimento.</span></span>
              </label>
              <label className={clsx("flex gap-3 rounded-xl border border-line bg-panel p-3 text-sm text-zinc-100",barberProfile.data?.pix_available?"cursor-pointer":"opacity-60")}>
                <input type="radio" name="paychoice" checked={paymentChoice==="pix"} disabled={!barberProfile.data?.pix_available} onChange={()=>setPaymentChoice("pix")} />
                <span><b>Pagar agora com Pix · {money(service.price_cents)}</b>
                  <span className="block text-xs text-zinc-400">{barberProfile.data?.pix_available
                    ?"O Pix será recebido diretamente na conta Mercado Pago deste profissional."
                    :"O profissional precisa conectar sua conta Mercado Pago para receber Pix."}</span>
                </span>
              </label>
              {paymentChoice==="pix"&&!form.email.trim()&&<p className="text-xs text-amber-400">Volte e informe um e-mail para gerar o Pix.</p>}
            </div>
            <div className="mt-5 flex items-center justify-between gap-2">
              <BackBtn onClick={() => setStep(4)} />
              <Button className="flex-1 justify-center py-3.5" disabled={confirming || (paymentChoice==="pix" && (!barberProfile.data?.pix_available || !form.email.trim()))} onClick={confirm}>
                {confirming ? <><Loader2 size={16} className="animate-spin" /> Reservando…</> : <><CalendarCheck2 size={17} /> Confirmar agendamento</>}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function BarberProfile({ data, tz }: { data: any; tz: string }) {
  const b = data.barber;
  const days: number[] = JSON.parse(b.work_days || "[]");
  const names = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
  return (
    <div className="animate-scale-in mt-1 rounded-2xl border border-line bg-ink-soft p-4">
      <p className="text-[13.5px] leading-relaxed text-zinc-300">{b.bio}</p>
      <div className="mt-3 grid gap-1.5 text-xs text-zinc-400 sm:grid-cols-2">
        <p>🗓 Atende: {days.map((d) => names[d]).join(", ")}</p>
        <p>🕘 Expediente: {b.work_start} – {b.work_end} <span className="text-zinc-600">(almoço {b.break_start}–{b.break_end})</span></p>
      </div>
      {data.reviews?.length > 0 && (
        <div className="mt-3 border-t border-line pt-3">
          <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.2em] text-[var(--c-gold)]">Avaliações recentes</p>
          <ul className="space-y-1.5">
            {data.reviews.slice(0, 3).map((r: any, i: number) => (
              <li key={i} className="text-[12.5px] text-zinc-400">“{r.comment}” <span className="text-zinc-600">— {r.customer_name}</span></li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function DateStep({ tz, barberId, serviceId, date, setDate, horizon, onBack }: any) {
  const [cursor, setCursor] = useState(() => localDay(tz).slice(0, 7));
  const month = useQuery({ queryKey: ["tenant", siteBase(), "avail-month", barberId, serviceId, cursor], queryFn: () => api.get<{ days: { day: string; status: string }[] }>(`/availability-month?barberId=${barberId}&serviceId=${serviceId}&month=${cursor}`) });
  const today = localDay(tz);
  const maxDay = useMemo(() => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + horizon); return d.toISOString().slice(0, 10); }, [today, horizon]);
  const [yy, mm] = cursor.split("-").map(Number);
  const firstWd = new Date(Date.UTC(yy, mm - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  const status = new Map((month.data?.days ?? []).map((d) => [d.day, d.status]));

  const shift = (n: number) => {
    const d = new Date(Date.UTC(yy, mm - 1 + n, 1));
    setCursor(d.toISOString().slice(0, 7));
  };

  return (
    <div className="mx-auto max-w-md">
      <p className="mb-4 font-display text-lg text-zinc-100">3. Escolha a data</p>
      <div className="rounded-2xl border border-line bg-panel p-4">
        <div className="mb-3 flex items-center justify-between">
          <button className="rounded-lg border border-line px-2.5 py-1.5 text-zinc-300 hover:border-[var(--c-gold)]" onClick={() => shift(-1)}>←</button>
          <p className="font-display text-base capitalize text-zinc-100">{MONTHS[mm - 1]} {yy}</p>
          <button className="rounded-lg border border-line px-2.5 py-1.5 text-zinc-300 hover:border-[var(--c-gold)]" onClick={() => shift(1)}>→</button>
        </div>
        <div className="grid grid-cols-7 gap-1 text-center text-[11px] text-zinc-500">{weekdayShort.map((w) => <div key={w}>{w}</div>)}</div>
        <div className="mt-1 grid grid-cols-7 gap-1">
          {Array.from({ length: firstWd }).map((_, i) => <div key={`e${i}`} />)}
          {Array.from({ length: daysInMonth }).map((_, i) => {
            const d = i + 1;
            const dayStr = `${yy}-${String(mm).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
            const st = status.get(dayStr);
            const disabled = dayStr < today || dayStr > maxDay || st === "day_off" || st === "full";
            return (
              <button
                key={d}
                disabled={disabled || month.isLoading}
                onClick={() => setDate(dayStr)}
                className={clsx(
                  "cal-day relative rounded-lg py-2 text-sm transition-all",
                  date === dayStr ? "bg-[var(--c-gold)] font-bold text-black" : disabled ? "text-zinc-700" : "text-zinc-200 hover:bg-gold-soft"
                )}
              >
                {d}
                {date !== dayStr && (st === "partial" || st === "full" || st === "day_off") && (
                  <span className="cal-dot">
                    {st === "partial" && <i className="h-1 w-1 rounded-full bg-emerald-400" />}
                    {st === "full" && <i className="h-1 w-1 rounded-full bg-red-400" />}
                    {st === "day_off" && <i className="h-1 w-1 rounded-full bg-zinc-600" />}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="mt-3 flex flex-wrap gap-3 border-t border-line pt-3 text-[10.5px] text-zinc-500">
          <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-emerald-400" /> livre</span>
          <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-red-400" /> cheio</span>
          <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full bg-zinc-600" /> folga/fechado</span>
        </div>
      </div>
      <div className="mt-4 flex justify-between"><BackBtn onClick={onBack} /><span className="text-[11px] text-zinc-600">Agenda até {maxDay.split("-").reverse().join("/")}</span></div>
    </div>
  );
}

function SuccessScreen({ done, settings, navigate }: any) {
  const b = done.booking;
  const day = new Date(b.starts_at);
  const [payment,setPayment]=useState(done.payment);
  const [checking,setChecking]=useState(false);
  const [copied,setCopied]=useState(false);
  const checkPayment=async()=>{
    setChecking(true);
    try {
      const result=await api.post<{payment:any}>("/bookings/pix/status",{
        code:b.code,phone:b.customer_phone,cancel_token:done.cancel_token
      });
      setPayment(result.payment);
    } catch { setPayment((p:any)=>({...p,message:"Não foi possível consultar o pagamento agora."})); }
    finally { setChecking(false); }
  };
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center px-4 pb-16 pt-24 text-center">
      <div className="animate-scale-in w-full rounded-3xl border border-[color-mix(in_srgb,var(--c-gold)_45%,transparent)] bg-panel p-7 shadow-gold">
        <div className="mx-auto mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-400"><CheckCircle2 size={34} /></div>
        <p className="text-[11px] font-bold uppercase tracking-[0.3em] text-[var(--c-gold)]">Reserva confirmada no sistema</p>
        <h2 className="mt-2 font-display text-[27px] leading-tight text-zinc-50">Seu horário foi registrado</h2>
        <p className="mt-4 space-y-1 text-sm text-zinc-300">
          <span className="block">Protocolo <b className="text-[var(--c-gold)]">{b.code}</b></span>
          <span className="block">{b.service_name} com <b>{b.barber_name}</b></span>
          <span className="block">{day.toLocaleString("pt-BR", { timeZone: settings?.timezone, weekday: "long", day: "2-digit", month: "long", hour: "2-digit", minute: "2-digit" })}</span>
          <span className="block font-semibold text-[var(--c-gold)]">{money(b.price_cents)}</span>
        </p>

        {done.payment_choice==="pix" && (
          <div className="mt-5 rounded-xl border border-[var(--c-gold)]/40 bg-ink-soft p-4 text-left text-sm">
            <p className="font-semibold text-zinc-100">Pagamento Pix · {money(b.price_cents)}</p>
            <p className="mt-1 text-xs text-zinc-400">
              {payment?.status==="paid"?"Pagamento confirmado pelo Mercado Pago.":
               payment?.status==="refund_required"?"Reserva cancelada após o pagamento: contate a barbearia para estorno.":
               payment?.status==="pending"?"Aguardando confirmação do Mercado Pago. Não pague duas vezes.":
               payment?.message||"Pix não gerado; consulte a barbearia para pagar no atendimento."}
            </p>
            {payment?.status==="pending"&&payment.qr_code_base64&&
              <img alt="QR Code Pix do agendamento" className="mx-auto my-3 w-48 rounded-lg bg-white p-2"
                src={"data:image/png;base64,"+payment.qr_code_base64} />}
            {payment?.status==="pending"&&payment.qr_code_text&&
              <div className="mt-3 space-y-2">
                <p className="text-xs text-zinc-400">Pix copia e cola</p>
                <p className="break-all rounded-lg bg-black/30 p-2 text-xs text-zinc-200">{payment.qr_code_text}</p>
                <Button variant="ghost" onClick={async()=>{await navigator.clipboard.writeText(payment.qr_code_text);setCopied(true);}}>
                  {copied?"Código copiado":"Copiar código Pix"}
                </Button>
              </div>}
            <div className="mt-3">
              <Button variant="ghost" disabled={checking} onClick={checkPayment}>
                {checking?"Consultando…":"Verificar pagamento"}
              </Button>
            </div>
          </div>
        )}
        {done.payment_choice!=="pix" && <p className="mt-4 text-xs text-zinc-400">Pagamento previsto após o atendimento.</p>}
        <div className="gold-hr my-5" />
        <p className="text-[12.5px] leading-relaxed text-zinc-400">
          Guarde seu protocolo. Você pode <b className="text-zinc-200">cancelar ou remarcar on-line</b> dentro do prazo
          {b.allowed_cancel_until ? ` (até ${new Date(b.allowed_cancel_until).toLocaleString("pt-BR", { timeZone: settings?.timezone })})` : ""} ou conforme a política da casa.
        </p>
        {done.whatsapp_link ? (
          <a href={done.whatsapp_link} target="_blank" rel="noreferrer" className="btn-gold mt-5 flex items-center justify-center gap-2 rounded-xl py-3 text-sm"><MessageCircle size={16} /> Confirmar também no WhatsApp</a>
        ) : (
          <p className="mt-5 rounded-xl border border-line bg-ink-soft p-3 text-[11.5px] text-zinc-500">WhatsApp da barbearia não configurado nas Configurações — avise-os por outros canais. <Badge tone="gray">integração opcional</Badge></p>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button variant="ghost" onClick={() => navigate(siteBase() + "/meus-agendamentos", { state: { code: b.code } })}>Gerenciar reserva</Button>
          <Button variant="ghost" onClick={() => navigate(siteBase())}>Voltar ao início</Button>
        </div>
      </div>
    </div>
  );
}

/* helpers de layout */
function Grid({ title, subtitle, children }: any) {
  return (
    <div>
      <p className="font-display text-lg text-zinc-100">{title}</p>
      {subtitle && <p className="mb-4 text-xs text-zinc-500">{subtitle}</p>}
      {!subtitle && <div className="mb-4" />}
      <div className="grid gap-3 sm:grid-cols-2">{children}</div>
    </div>
  );
}
function ChoiceCard({ selected, onClick, children }: any) {
  return (
    <button onClick={onClick} className={clsx("card-luxe overflow-hidden rounded-2xl border bg-panel text-left", selected ? "border-[var(--c-gold)] shadow-gold" : "border-line")}>
      {children}
    </button>
  );
}
function Row({ icon, k, v }: any) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex items-center gap-2 text-zinc-500">{icon} {k}</span>
      <span className="text-right font-medium text-zinc-100">{v}</span>
    </div>
  );
}
function BackBtn({ onClick }: { onClick: () => void }) {
  return <button onClick={onClick} className="inline-flex items-center gap-1 text-sm text-zinc-500 transition-colors hover:text-[var(--c-gold)]"><ChevronLeft size={15} /> Voltar</button>;
}
