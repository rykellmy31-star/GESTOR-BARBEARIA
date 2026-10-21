import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { CalendarClock, CalendarX2, LogIn } from "lucide-react";
import { api, siteBase } from "@/lib/api";
import { useConfig } from "@/lib/hooks";
import { Badge, Button, ConfirmDialog, Field, Input, Spinner, useToast } from "@/components/ui";
import { fmtDateTime, maskPhone, money } from "@/lib/format";

const STATUS_TONE: Record<string, any> = { pendente: "amber", confirmado: "green", concluido: "gray", cancelado: "red", no_show: "red", bloqueio: "blue" };

export function MyBookingsPage() {
  const loc = useLocation() as any;
  const { data: cfg } = useConfig();
  const tz = cfg?.settings.timezone || "America/Bahia";
  const toast = useToast();
  const [code, setCode] = useState(loc.state?.code || localStorage.getItem(`tigu_last_code:${siteBase()}`) || "");
  const [phone, setPhone] = useState(localStorage.getItem(`tigu_last_phone:${siteBase()}`) || "");
  const [busy, setBusy] = useState(false);
  const [rows, setRows] = useState<any[] | null>(null);
  const [cancelTarget, setCancelTarget] = useState<any | null>(null);
  const [reschedTarget, setReschedTarget] = useState<any | null>(null);
  const [slots, setSlots] = useState<any[]>([]);

  const lookup = async () => {
    if (!code || !phone) return toast.push("err", "Informe protocolo e WhatsApp.");
    setBusy(true);
    try {
      const d = await api.get(`/bookings/lookup?code=${encodeURIComponent(code.trim().toUpperCase())}&phone=${encodeURIComponent(phone.replace(/\D/g, ""))}`);
      setRows(d.bookings);
      localStorage.setItem(`tigu_last_code:${siteBase()}`, code);
      localStorage.setItem(`tigu_last_phone:${siteBase()}`, phone);
    } catch (e: any) {
      toast.push("err", e.message);
      setRows([]);
    } finally { setBusy(false); }
  };

  const doCancel = async () => {
    try {
      await api.post("/bookings/cancel", { code: cancelTarget.code, phone: phone.replace(/\D/g, "") });
      toast.push("ok", "Agendamento cancelado — o horário foi liberado.");
      setCancelTarget(null);
      lookup();
    } catch (e: any) { toast.push("err", e.message); }
  };

  useEffect(() => {
    if (code && loc.state?.code) lookup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openResched = async (b: any) => {
    setReschedTarget(b);
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(b.starts_at));
    const d = await api.get(`/availability?barberId=${b.barber_id ?? ""}&serviceId=${b.service_id}&date=${day}`).catch(() => null);
    setSlots(d?.slots ?? []);
    if (!d?.slots?.length) toast.push("info", "Sem horários livres neste dia; fale com a barbearia pelo WhatsApp para remarcar.");
  };

  const doReschedule = async (t: string) => {
    try {
      const r = await api.post("/bookings/reschedule", { code: reschedTarget.code, phone: phone.replace(/\D/g, ""), startsAt: t });
      toast.push("ok", `Remarcado para ${fmtDateTime(r.starts_at, tz)}.`);
      setReschedTarget(null);
      lookup();
    } catch (e: any) { toast.push("err", e.message); }
  };

  return (
    <div className="mx-auto min-h-screen max-w-xl px-4 pb-20 pt-24">
      <h1 className="mb-1 flex items-center gap-2 font-display text-3xl text-zinc-50"><CalendarClock className="text-[var(--c-gold)]" /> Meus agendamentos</h1>
      <p className="mb-6 text-sm text-zinc-500">Consulte, remarque ou cancele usando o protocolo recebido na confirmação + seu WhatsApp.</p>

      <div className="space-y-3 rounded-2xl border border-line bg-panel p-5">
        <Field label="Protocolo"><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="AUR-XXXXXXXX" /></Field>
        <Field label="WhatsApp cadastrado"><Input value={phone} onChange={(e) => setPhone(maskPhone(e.target.value))} placeholder="(75) 99999-0000" inputMode="tel" /></Field>
        <Button className="w-full justify-center" onClick={lookup} disabled={busy}>{busy ? "Buscando…" : <><LogIn size={15} /> Consultar</>}</Button>
      </div>

      {rows && (
        <div className="mt-5 space-y-3">
          {rows.length === 0 && <p className="rounded-xl border border-line p-5 text-center text-sm text-zinc-500">Nenhum agendamento encontrado com esses dados.</p>}
          {rows.map((b) => (
            <div key={b.id} className="rounded-2xl border border-line bg-panel p-4">
              <div className="flex items-center justify-between">
                <p className="font-display text-lg text-zinc-100">{b.service_name}</p>
                <Badge tone={STATUS_TONE[b.status] || "gray"}>{b.status}</Badge>
              </div>
              <p className="mt-1 text-sm text-zinc-400">{fmtDateTime(b.starts_at, tz)} · {b.barber_name} · {money(b.price_cents)}</p>
              <p className="mt-0.5 text-xs text-zinc-600">Protocolo {b.code}</p>
              <div className="mt-3 flex gap-2">
                {b.can_reschedule && b.barber_id && <Button size="sm" variant="ghost" onClick={() => openResched(b)}>Remarcar</Button>}
                {b.can_cancel && <Button size="sm" variant="danger" onClick={() => setCancelTarget(b)}><CalendarX2 size={13} /> Cancelar</Button>}
                {!b.can_cancel && !b.can_reschedule && <span className="text-xs text-zinc-600">Fora do prazo de alteração on-line — use o WhatsApp.</span>}
              </div>
            </div>
          ))}
          <p className="px-1 text-[11px] leading-relaxed text-zinc-600">{cfg?.settings.cancel_policy_text}</p>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(cancelTarget)}
        onCancel={() => setCancelTarget(null)}
        onConfirm={doCancel}
        danger
        title="Cancelar agendamento?"
        text={`O horário ${cancelTarget ? fmtDateTime(cancelTarget.starts_at, tz) : ""} será liberado para outros clientes. Esta ação não pode ser desfeita — será preciso agendar novamente.`}
      />

      {reschedTarget && (
        <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center">
          <div className="modal-backdrop absolute inset-0" onClick={() => setReschedTarget(null)} />
          <div className="animate-scale-in relative max-h-[80vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-panel p-5 sm:max-w-sm sm:rounded-2xl">
            <p className="mb-1 font-display text-lg text-zinc-100">Novo horário — {reschedTarget.barber_name}</p>
            <p className="mb-4 text-xs text-zinc-500">Somente horários livres do mesmo dia, na grade do barbeiro.</p>
            {slots.length === 0 ? <Spinner label="Buscando horários livres…" /> : (
              <div className="grid grid-cols-4 gap-2">
                {slots.map((s) => (
                  <button key={s.t} onClick={() => doReschedule(s.t)} className="rounded-lg border border-line bg-ink-soft py-2 text-sm text-zinc-100 hover:border-[var(--c-gold)]">{s.label}</button>
                ))}
              </div>
            )}
            <Button variant="ghost" className="mt-4 w-full justify-center" onClick={() => setReschedTarget(null)}>Fechar</Button>
          </div>
        </div>
      )}
    </div>
  );
}
