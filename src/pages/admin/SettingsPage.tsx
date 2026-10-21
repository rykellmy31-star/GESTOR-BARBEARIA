import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Info, Save, ShieldCheck } from "lucide-react";
import { api, siteBase } from "@/lib/api";
import { Badge, Button, Field, Input, Select, Spinner, Textarea, useToast } from "@/components/ui";
import { ImageUpload } from "@/components/ui/Upload";
import { fmtDateTime } from "@/lib/format";
import type { ShopSettings } from "@/lib/types";

const DAYS = ["Domingo", "Segunda", "Terça", "Quarta", "Quinta", "Sexta", "Sábado"];
const PRESETS = [
  { name: "Ouro clássico", gold: "#d4af37", ink: "#0a0a0c", panel: "#16161c", line: "#26262f" },
  { name: "Champanhe", gold: "#e8c56a", ink: "#101014", panel: "#1a1a22", line: "#2c2c38" },
  { name: "Rosé", gold: "#d9a066", ink: "#121012", panel: "#1d1a1c", line: "#302c2f" },
  { name: "Grafite frio", gold: "#b8b8c4", ink: "#0c0d10", panel: "#17181d", line: "#272932" },
];

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ["admin-settings", siteBase()], queryFn: () => api.get<any>("/admin/settings").then((d) => d.settings as ShopSettings) });
  const tenant = siteBase();
  const [s, setS] = useState<ShopSettings | null>(null);
  const [loadedTenant, setLoadedTenant] = useState<string | null>(null);
  useEffect(() => {
    if (q.data && loadedTenant !== tenant) {
      setS(JSON.parse(JSON.stringify(q.data)));
      setLoadedTenant(tenant);
    }
  }, [q.data, loadedTenant, tenant]);

  const save = useMutation({
    mutationFn: () => api.put("/admin/settings", s),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["admin-settings"] }); qc.invalidateQueries({ queryKey: ["config"] }); toast.push("ok", "Configurações salvas — site atualizado em tempo real (tema incluso)."); },
    onError: (e: any) => toast.push("err", e.message || "Dados inválidos — revise os campos destacados pelo servidor."),
  });
  const audit = useQuery({ queryKey: ["audit", siteBase()], queryFn: () => api.get<any>("/admin/audit?limit=25").then((d) => d.log) });

  if (!s || loadedTenant !== tenant) return <Spinner label="Carregando configurações…" />;
  const set = (patch: Partial<ShopSettings>) => setS({ ...s, ...patch });
  const setBrand = (patch: Partial<ShopSettings["brand"]>) => setS({ ...s, brand: { ...s.brand, ...patch } });

  return (
    <div className="max-w-4xl space-y-6 pb-16">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-2xl text-zinc-50">Configurações</h1>
          <p className="text-xs text-zinc-500">Identidade, horários, regras de agendamento e permissões — tudo aplicado ao site sem deploy.</p>
        </div>
        <Button onClick={() => save.mutate()} disabled={save.isPending}><Save size={15} /> {save.isPending ? "Salvando…" : "Salvar alterações"}</Button>
      </div>

      <Card title="Identidade da barbearia">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nome" required><Input value={s.shop_name} onChange={(e) => set({ shop_name: e.target.value })} /></Field>
          <Field label="Slogan"><Input value={s.tagline} onChange={(e) => set({ tagline: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Field label="Sobre (rodapé / SEO)"><Textarea value={s.about} onChange={(e) => set({ about: e.target.value })} /></Field></div>
          <Field label="Telefone"><Input value={s.phone} onChange={(e) => set({ phone: e.target.value })} placeholder="(75) 3641-0000" /></Field>
          <Field label="WhatsApp" hint="somente números com DDI, ex.: 5575999990000"><Input value={s.whatsapp} onChange={(e) => set({ whatsapp: e.target.value.replace(/\D/g, "") })} /></Field>
          <Field label="E-mail"><Input value={s.email} onChange={(e) => set({ email: e.target.value })} /></Field>
          <Field label="Instagram (URL)"><Input value={s.instagram} onChange={(e) => set({ instagram: e.target.value })} placeholder="https://instagram.com/…" /></Field>
          <div className="sm:col-span-2"><Field label="Endereço"><Input value={s.address} onChange={(e) => set({ address: e.target.value })} /></Field></div>
          <div className="sm:col-span-2"><Field label="Busca do mapa (Google Maps)" hint="o que você digitaria no maps para achar a loja"><Input value={s.maps_query} onChange={(e) => set({ maps_query: e.target.value })} placeholder="Barbearia Aurum, Mutuípe - BA" /></Field></div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2">
          <ImageUpload label="Logo" value={s.logo_url} onChange={(logo_url) => set({ logo_url })} aspect="aspect-[3/1]" />
          <ImageUpload label="Foto de capa (hero)" value={s.banner_url} onChange={(banner_url) => set({ banner_url })} />
        </div>
      </Card>

      <Card title="Aparência & marca" subtitle="As cores são injetadas em todo o site na hora — valide o contraste antes de publicar.">
        <div className="mb-3 flex flex-wrap gap-2">
          {PRESETS.map((p) => (
            <button key={p.name} onClick={() => setBrand({ gold: p.gold, ink: p.ink, panel: p.panel, line: p.line })}
              className="flex items-center gap-2 rounded-xl border border-line px-3 py-2 text-xs text-zinc-300 hover:border-[var(--c-gold)]">
              <span className="flex gap-0.5"><i className="h-4 w-4 rounded" style={{ background: p.ink }} /><i className="h-4 w-4 rounded" style={{ background: p.panel }} /><i className="h-4 w-4 rounded" style={{ background: p.gold }} /></span>
              {p.name}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {([["gold", "Dourado (destaques)"], ["ink", "Fundo"], ["panel", "Cards"], ["line", "Linhas"]] as const).map(([k, label]) => (
            <Field key={k} label={label}>
              <div className="flex items-center gap-2">
                <input type="color" value={(s.brand as any)[k]} onChange={(e) => setBrand({ [k]: e.target.value } as any)} className="h-9 w-9 cursor-pointer rounded-lg border border-line bg-transparent p-0.5" />
                <Input value={(s.brand as any)[k]} onChange={(e) => setBrand({ [k]: e.target.value } as any)} className="font-mono text-xs" />
              </div>
            </Field>
          ))}
        </div>
      </Card>

      <Card title="Horários de funcionamento">
        <div className="grid gap-2 sm:grid-cols-2">
          {DAYS.map((name, d) => {
            const h = s.opening_hours?.[String(d)];
            return (
              <div key={d} className="flex items-center gap-2 rounded-xl border border-line px-3 py-2">
                <span className="w-20 text-sm text-zinc-300">{name}</span>
                {h ? (
                  <>
                    <Input type="time" step={600} value={h.open} className="w-28 py-1.5 text-sm" onChange={(e) => set({ opening_hours: { ...s.opening_hours, [String(d)]: { ...h, open: e.target.value } } })} />
                    <span className="text-zinc-600">–</span>
                    <Input type="time" step={600} value={h.close} className="w-28 py-1.5 text-sm" onChange={(e) => set({ opening_hours: { ...s.opening_hours, [String(d)]: { ...h, close: e.target.value } } })} />
                    <button className="ml-auto text-xs text-red-400 hover:underline" onClick={() => set({ opening_hours: { ...s.opening_hours, [String(d)]: null } })}>fechar dia</button>
                  </>
                ) : (
                  <>
                    <span className="text-sm text-zinc-500">Fechado</span>
                    <button className="ml-auto text-xs text-[var(--c-gold)] hover:underline" onClick={() => set({ opening_hours: { ...s.opening_hours, [String(d)]: { open: "09:00", close: "20:00" } } })}>abrir neste dia</button>
                  </>
                )}
              </div>
            );
          })}
        </div>
        <p className="mt-2 text-[11px] text-zinc-600"><Info size={11} className="mr-1 inline" /> Feriados/pontos facais e folgas individuais são lançados na Agenda (botões “Folgas” / “Bloquear intervalo”). O fuso: <Select className="inline w-auto py-1 text-xs" value={s.timezone} onChange={(e) => set({ timezone: e.target.value })}>{["America/Bahia", "America/Sao_Paulo", "America/Manaus", "America/Belem"].map((z) => <option key={z}>{z}</option>)}</Select> <span className="text-zinc-600">· moeda: <Badge tone="gray">BRL</Badge></span></p>
      </Card>

      <Card title="Regras de agendamento" subtitle="As mesmas validadas no servidor pelo motor de disponibilidade — o site apenas reflete.">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Field label="Passo da grade (min)"><Input type="number" min={5} max={120} step={5} value={s.slot_step_min} onChange={(e) => set({ slot_step_min: Number(e.target.value) })} /></Field>
          <Field label="Antecedência mín. (min)"><Input type="number" min={0} value={s.min_lead_min} onChange={(e) => set({ min_lead_min: Number(e.target.value) })} /></Field>
          <Field label="Janela (dias à frente)"><Input type="number" min={3} max={120} value={s.horizon_days} onChange={(e) => set({ horizon_days: Number(e.target.value) })} /></Field>
          <Field label="Prazo p/ cancelar (min antes)"><Input type="number" min={0} value={s.cancel_cutoff_min} onChange={(e) => set({ cancel_cutoff_min: Number(e.target.value) })} /></Field>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <Toggle label="Cliente pode cancelar on-line" v={s.allow_online_cancel} set={(v) => set({ allow_online_cancel: v })} />
          <Toggle label="Cliente pode remarcar on-line" v={s.allow_online_reschedule} set={(v) => set({ allow_online_reschedule: v })} />
        </div>
        <div className="mt-3"><Field label="Política exibida no site"><Textarea value={s.cancel_policy_text} onChange={(e) => set({ cancel_policy_text: e.target.value })} /></Field></div>
      </Card>

      <Card title="Recursos & permissões">
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle label="Barbeiro pode concluir / marcar no-show" v={s.barber_can_conclude} set={(v) => set({ barber_can_conclude: v })} />
          <Toggle label="Barbeiro pode cancelar reserva própria" v={s.barber_can_cancel} set={(v) => set({ barber_can_cancel: v })} />
          <Toggle label="Barbeiro pode pedir bloqueio de agenda" v={s.barber_can_block} set={(v) => set({ barber_can_block: v })} />
          <Toggle label="Seção de avaliações no site" v={s.reviews_enabled} set={(v) => set({ reviews_enabled: v })} />
          <Toggle label="Loja de produtos no site" v={s.products_enabled} set={(v) => set({ products_enabled: v })} />
          <Toggle label="Botões de WhatsApp" v={s.whatsapp_buttons_enabled} set={(v) => set({ whatsapp_buttons_enabled: v })} />
        </div>
      </Card>

      <Card title="Registro de auditoria" subtitle="Quem mudou o quê, quando (últimas 25 ações)." icon={<ShieldCheck size={15} />}>
        <ul className="max-h-72 space-y-1 overflow-y-auto font-mono text-[11px]">
          {(audit.data ?? []).map((x: any) => (
            <li key={x.id} className="flex gap-2 rounded-lg border border-line px-2 py-1 text-zinc-400">
              <span className="text-zinc-600">{fmtDateTime(x.created_at)}</span>
              <span className="text-[var(--c-gold)]">{x.actor ?? "sistema"}</span>
              <span>{x.action} {x.entity}#{x.entity_id ?? ""}</span>
              {x.details && <span className="min-w-0 flex-1 truncate text-zinc-600">{x.details}</span>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}

function Card({ title, subtitle, children, icon }: any) {
  return (
    <section className="rounded-2xl border border-line bg-panel p-5">
      <h2 className="flex items-center gap-2 font-display text-lg text-zinc-100">{icon} {title}</h2>
      {subtitle && <p className="mb-3 mt-0.5 text-xs text-zinc-500">{subtitle}</p>}
      {!subtitle && <div className="mb-3" />}
      {children}
    </section>
  );
}
function Toggle({ label, v, set }: { label: string; v: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" onClick={() => set(!v)} className="flex items-center gap-2.5 rounded-xl border border-line px-3 py-2.5 text-left text-sm text-zinc-300 transition-colors hover:border-zinc-500">
      <span className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${v ? "bg-[var(--c-gold)]" : "bg-zinc-700"}`}><span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${v ? "left-[18px]" : "left-0.5"}`} /></span>
      {label}
    </button>
  );
}
