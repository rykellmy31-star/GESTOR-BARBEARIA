import type { ReactNode } from "react";
import { money } from "@/lib/format";

export function H({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex min-w-0 flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-end sm:justify-between">
      <div className="min-w-0 max-w-full">
        <h1 className="break-words font-display text-2xl text-zinc-50">{title}</h1>
        {sub && <p className="mt-1 break-words text-xs text-zinc-500">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: "gold" | "green" | "red" }) {
  const color = tone === "gold" ? "gold-text" : tone === "green" ? "text-emerald-300" : tone === "red" ? "text-red-300" : "text-zinc-50";
  return (
    <div className="card-luxe min-w-0 rounded-2xl border border-[#26262f] bg-[#16161c] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1.5 break-words font-display text-[24px] leading-tight ${color}`}>{value}</p>
      {sub && <p className="mt-1.5 text-[11px] text-zinc-500">{sub}</p>}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="min-w-0 w-full max-w-full overflow-x-auto rounded-2xl border border-[#26262f] bg-[#16161c]" role="region" aria-label="Tabela com rolagem horizontal quando necessário" tabIndex={0}>
      <table className="min-w-[640px] w-full text-sm"><thead><tr className="border-b border-[#26262f] text-left text-[11px] uppercase tracking-wide text-zinc-500">{head.map((h, i) => <th key={i} className="px-4 py-2.5 font-semibold">{h}</th>)}</tr></thead><tbody>{children}</tbody></table>
    </div>
  );
}
export const Tr = ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
  <tr onClick={onClick} className={`border-b border-[#26262f]/60 text-zinc-300 last:border-0 ${onClick ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}>{children}</tr>
);
export const Td = ({ children, className = "" }: { children?: ReactNode; className?: string }) => <td className={`px-4 py-2.5 ${className}`}>{children}</td>;

export const Money = ({ cents }: { cents: number | null | undefined }) => <span className="font-mono text-[13px]">{money(Number(cents ?? 0))}</span>;
