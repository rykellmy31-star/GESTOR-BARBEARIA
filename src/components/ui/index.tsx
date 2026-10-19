import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { clsx } from "clsx";
import { AlertTriangle, CheckCircle2, Info, X } from "lucide-react";

/* ───────────── Toast ───────────── */
type Toast = { id: number; kind: "ok" | "err" | "info"; text: string };
const ToastCtx = createContext<{ push: (kind: Toast["kind"], text: string) => void }>({ push: () => {} });
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast["kind"], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), 5200);
  }, []);
  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastCtx.Provider value={value}>
      {children}
      <div className="fixed bottom-4 right-4 z-[100] flex w-[min(92vw,380px)] flex-col gap-2">
        {items.map((t) => (
          <div key={t.id} className={clsx("toast-in flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-sm shadow-card backdrop-blur",
            t.kind === "ok" && "border-emerald-500/30 bg-emerald-950/85 text-emerald-100",
            t.kind === "err" && "border-red-500/30 bg-red-950/85 text-red-100",
            t.kind === "info" && "border-zinc-600/50 bg-panel text-zinc-100")}>
            {t.kind === "ok" ? <CheckCircle2 size={17} className="mt-0.5 shrink-0 text-emerald-400" /> : t.kind === "err" ? <AlertTriangle size={17} className="mt-0.5 shrink-0 text-red-400" /> : <Info size={17} className="mt-0.5 shrink-0 text-zinc-300" />}
            <span className="leading-snug">{t.text}</span>
            <button onClick={() => setItems((x) => x.filter((y) => y.id !== t.id))} className="ml-auto text-zinc-400 hover:text-white"><X size={14} /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/* ───────────── Button ───────────── */
import { type ButtonHTMLAttributes, type AnchorHTMLAttributes } from "react";
type Variant = "gold" | "ghost" | "dark" | "danger" | "subtle";
const btnBase = "inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 text-sm font-medium transition-all disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--c-gold)]";
const variants: Record<Variant, string> = {
  gold: "btn-gold",
  ghost: "btn-ghost text-zinc-200",
  dark: "bg-ink-soft border border-line text-zinc-200 hover:border-zinc-500",
  danger: "bg-red-950/70 border border-red-800/60 text-red-200 hover:bg-red-900/70",
  subtle: "bg-gold-soft text-[var(--c-gold)] hover:brightness-125 border border-[color-mix(in_srgb,var(--c-gold)_35%,transparent)]",
};
export function Button({ variant = "gold", className, size, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return <button {...rest} className={clsx(btnBase, variants[variant], size === "sm" && "px-3 py-1.5 text-xs", size === "lg" && "px-6 py-3.5 text-base", className)} />;
}
export function LinkButton({ variant = "gold", className, ...rest }: AnchorHTMLAttributes<HTMLAnchorElement> & { variant?: Variant }) {
  return <a {...rest} className={clsx(btnBase, variants[variant], className)} />;
}

/* ───────────── Form fields ───────────── */
export function Field({ label, hint, children, required }: { label: string; hint?: string; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1.5 flex items-baseline gap-1 text-[12.5px] font-medium uppercase tracking-wide text-zinc-400">
        {label}{required && <span className="text-[var(--c-gold)]">*</span>}
      </span>
      {children}
      {hint && <span className="mt-1 block text-xs text-zinc-500">{hint}</span>}
    </label>
  );
}
export function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={clsx("input-dark", props.className)} />;
}
export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={clsx("input-dark min-h-[84px]", props.className)} />;
}
export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={clsx("input-dark appearance-none", props.className)} />;
}

/* ───────────── Modal ───────────── */
import { useEffect as useEff } from "react";
export function Modal({ open, onClose, title, children, wide }: { open: boolean; onClose: () => void; title: string; children: ReactNode; wide?: boolean }) {
  useEff(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    document.body.style.overflow = "hidden";
    return () => { window.removeEventListener("keydown", h); document.body.style.overflow = ""; };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="modal-backdrop fixed inset-0 z-[90] flex items-end justify-center p-0 sm:items-center sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={clsx("animate-scale-in max-h-[92vh] w-full overflow-y-auto rounded-t-2xl border border-line bg-panel shadow-card sm:rounded-2xl", wide ? "sm:max-w-3xl" : "sm:max-w-lg")}>
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-panel px-5 py-3.5 backdrop-blur">
          <h3 className="font-display text-lg text-zinc-100">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-zinc-400 hover:bg-ink-soft hover:text-white"><X size={18} /></button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onCancel, onConfirm, title, text, danger }: { open: boolean; onCancel: () => void; onConfirm: () => void; title: string; text: string; danger?: boolean }) {
  return (
    <Modal open={open} onClose={onCancel} title={title}>
      <p className="mb-5 text-sm leading-relaxed text-zinc-300">{text}</p>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>Voltar</Button>
        <Button variant={danger ? "danger" : "gold"} onClick={onConfirm}>Confirmar</Button>
      </div>
    </Modal>
  );
}

/* ───────────── misc ───────────── */
export function Badge({ children, tone = "gold" }: { children: ReactNode; tone?: "gold" | "gray" | "green" | "red" | "amber" | "blue" }) {
  const tones = {
    gold: "bg-gold-soft text-[var(--c-gold)] border-[color-mix(in_srgb,var(--c-gold)_30%,transparent)]",
    gray: "bg-zinc-800/60 text-zinc-300 border-zinc-700",
    green: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    red: "bg-red-500/10 text-red-300 border-red-500/30",
    amber: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    blue: "bg-sky-500/10 text-sky-300 border-sky-500/30",
  };
  return <span className={clsx("inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold", tones[tone])}>{children}</span>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-10 text-zinc-400">
      <svg className="h-5 w-5 animate-spin" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="3" /><path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" /></svg>
      {label && <span className="text-sm">{label}</span>}
    </div>
  );
}

export function EmptyState({ icon, title, text, action }: { icon: ReactNode; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      <div className="text-zinc-500">{icon}</div>
      <p className="font-display text-lg text-zinc-200">{title}</p>
      {text && <p className="max-w-md text-sm text-zinc-500">{text}</p>}
      {action && <div className="mt-3">{action}</div>}
    </div>
  );
}

export function SectionTitle({ kicker, title, subtitle }: { kicker?: string; title: string; subtitle?: string }) {
  return (
    <div className="reveal mx-auto mb-10 max-w-2xl text-center">
      {kicker && <p className="mb-2 text-[11px] font-bold uppercase tracking-[0.35em] text-[var(--c-gold)]">{kicker}</p>}
      <h2 className="font-display text-3xl font-semibold text-zinc-50 sm:text-4xl">{title}</h2>
      <div className="gold-hr mx-auto mt-4 w-24" />
      {subtitle && <p className="mt-4 text-sm leading-relaxed text-zinc-400">{subtitle}</p>}
    </div>
  );
}
