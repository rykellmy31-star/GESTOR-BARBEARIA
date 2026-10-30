import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { CalendarClock, CheckCircle2, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useConfig } from "@/lib/hooks";
import { Button, Input, Spinner } from "@/components/ui";
import { fmtDateTime, localDay } from "@/lib/format";

type Details = {
  booking: {
    code: string; customer_name: string; starts_at: string;
    service_name: string; barber_name: string; barber_id: number;
    service_id: number; status: string;
  };
  confirmed_by_customer: boolean;
  can_confirm: boolean;
  can_reschedule: boolean;
  timezone: string;
};
type Slot = { t: string; label: string; available?: boolean };

export function WhatsappBookingActionPage() {
  const [params] = useSearchParams();
  const { data: config } = useConfig();
  const code = params.get("codigo") || "";
  const token = params.get("token") || "";
  const [details, setDetails] = useState<Details | null>(null);
  const [pending, setPending] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [reschedule, setReschedule] = useState(false);
  const [date, setDate] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const tz = details?.timezone || config?.settings.timezone || "America/Bahia";
  const day = localDay(tz);

  async function loadDetails() {
    if (!code || !token) { setError("Link inválido ou incompleto."); setPending(false); return; }
    try {
      const d = await api.post<Details>("/bookings/action/lookup", { code, token });
      setDetails(d);
      setError("");
    } catch (e: any) { setError(e.message || "Não foi possível consultar o agendamento."); }
    finally { setPending(false); }
  }
  useEffect(() => { void loadDetails(); }, [code, token]);

  async function confirm() {
    setSaving(true); setError("");
    try {
      const result = await api.post<{message:string}>("/bookings/action/confirm", { code, token });
      setSuccess(result.message);
      await loadDetails();
    } catch (e:any) { setError(e.message || "Não foi possível confirmar."); }
    finally { setSaving(false); }
  }

  useEffect(() => {
    if (!reschedule || !details || !date) return;
    let active = true;
    setSlotsLoading(true); setSlots([]);
    api.get<{slots:Slot[]}>(`/availability?barberId=${details.booking.barber_id}&serviceId=${details.booking.service_id}&day=${date}`)
      .then((result) => { if (active) setSlots((result.slots || []).filter(x => x.available !== false)); })
      .catch(() => { if (active) setError("Falha ao consultar os horários livres."); })
      .finally(() => { if (active) setSlotsLoading(false); });
    return () => { active = false; };
  }, [reschedule, date, details?.booking.barber_id, details?.booking.service_id]);

  async function choose(t: string) {
    setSaving(true); setError("");
    try {
      const result = await api.post<{message:string}>("/bookings/action/reschedule", {
        code, token, startsAt: t
      });
      setSuccess(result.message);
      setReschedule(false);
      await loadDetails();
    } catch (e:any) {
      setError(e.message || "Esse horário não está mais disponível.");
      setSlots([]);
      setDate("");
    } finally { setSaving(false); }
  }

  if (pending) return <div className="mx-auto max-w-lg pt-28"><Spinner label="Consultando agendamento…" /></div>;
  return <main className="mx-auto max-w-lg space-y-5 px-4 pb-20 pt-24">
    <header>
      <h1 className="flex items-center gap-2 font-display text-2xl text-zinc-50">
        <CalendarClock className="text-[var(--c-gold)]" /> Seu agendamento
      </h1>
      <p className="mt-2 text-sm text-zinc-400">
        Confirme sua presença ou escolha outro horário disponível na barbearia.
      </p>
    </header>
    {error && <p role="alert" className="rounded-xl border border-red-700/40 bg-red-900/20 p-4 text-sm text-red-200">{error}</p>}
    {success && <p role="status" className="rounded-xl border border-emerald-700/40 bg-emerald-900/20 p-4 text-sm text-emerald-200">{success}</p>}
    {details && <section className="space-y-4 rounded-2xl border border-line bg-panel p-5">
      <div className="text-sm text-zinc-300">
        <p><strong>Cliente:</strong> {details.booking.customer_name}</p>
        <p><strong>Serviço:</strong> {details.booking.service_name}</p>
        <p><strong>Profissional:</strong> {details.booking.barber_name}</p>
        <p><strong>Data:</strong> {fmtDateTime(details.booking.starts_at,tz)}</p>
        <p className="mt-2 text-xs text-zinc-500">Protocolo: {details.booking.code}</p>
      </div>
      {details.confirmed_by_customer && <p className="flex items-center gap-2 text-sm text-emerald-300">
        <CheckCircle2 size={16}/> Presença confirmada por você.
      </p>}
      {details.can_confirm && !details.confirmed_by_customer && (
        <Button className="btn-gold w-full justify-center" disabled={saving}
          onClick={()=>void confirm()}>
          <CheckCircle2 size={16}/>{saving ? "Confirmando…" : "✅ Confirmar agendamento"}
        </Button>
      )}
      {details.can_reschedule && !reschedule && (
        <Button variant="outline" className="w-full justify-center"
          onClick={()=>{ setReschedule(true); setDate(day); setSuccess(""); }}>
          <RefreshCw size={16}/> Não dá, reagendar
        </Button>
      )}
      {!details.can_confirm && !details.can_reschedule && !details.confirmed_by_customer && (
        <p className="text-sm text-zinc-500">Este agendamento não permite mais alterações pelo site.</p>
      )}
      {reschedule && details.can_reschedule && (
        <div className="space-y-3 border-t border-line pt-4">
          <p className="font-semibold text-zinc-200">Escolha uma nova data e horário</p>
          <Input type="date" min={day} value={date} onChange={e=>setDate(e.target.value)} />
          {slotsLoading ? <Spinner label="Buscando horários livres…" /> : (
            <div className="grid grid-cols-3 gap-2">
              {slots.map(slot=><Button key={slot.t} variant="outline" disabled={saving}
                onClick={()=>void choose(slot.t)}>{slot.label}</Button>)}
            </div>
          )}
          {!slotsLoading && slots.length===0 && <p className="text-xs text-zinc-500">
            Não há horários livres nessa data. Escolha outro dia.
          </p>}
          <Button variant="ghost" onClick={()=>setReschedule(false)}>Voltar</Button>
        </div>
      )}
    </section>}
    <p className="text-xs text-zinc-500">
      Esta página é exclusiva do seu agendamento. Não encaminhe este link para outras pessoas.
    </p>
  </main>;
}
