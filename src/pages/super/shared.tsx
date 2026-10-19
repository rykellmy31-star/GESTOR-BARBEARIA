import type { ReactNode } from "react";
import { money } from "@/lib/format";

export function H({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl text-zinc-50">{title}</h1>
        {sub && <p className="mt-1 text-xs text-zinc-500">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Kpi({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: string; tone?: "gold" | "green" | "red" }) {
  const color = tone === "gold" ? "gold-text" : tone === "green" ? "text-emerald-300" : tone === "red" ? "text-red-300" : "text-zinc-50";
  return (
    <div className="card-luxe rounded-2xl border border-[#26262f] bg-[#16161c] p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1.5 font-display text-[24px] leading-none ${color}`}>{value}</p>
      {sub && <p className="mt-1.5 text-[11px] text-zinc-500">{sub}</p>}
    </div>
  );
}

export function Table({ head, children }: { head: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-[#26262f] bg-[#16161c]">
      <table className="w-full text-sm"><thead><tr className="border-b border-[#26262f] text-left text-[11px] uppercase tracking-wide text-zinc-500">{head.map((h, i) => <th key={i} className="px-4 py-2.5 font-semibold">{h}</th>)}</tr></thead><tbody>{children}</tbody></table>
    </div>
  );
}
export const Tr = ({ children, onClick }: { children: ReactNode; onClick?: () => void }) => (
  <tr onClick={onClick} className={`border-b border-[#26262f]/60 text-zinc-300 last:border-0 ${onClick ? "cursor-pointer hover:bg-white/[0.03]" : ""}`}>{children}</tr>
);
export const Td = ({ children, className = "" }: { children?: ReactNode; className?: string }) => <td className={`px-4 py-2.5 ${className}`}>{children}</td>;

export const Money = ({ cents }: { cents: number | null | undefined }) => <span className="font-mono text-[13px]">{money(Number(cents ?? 0))}</span>;
