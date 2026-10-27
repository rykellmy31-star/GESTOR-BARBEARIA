import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { Badge, Select, Spinner } from "@/components/ui";
import { H, Table, Td, Tr } from "./shared";

export function SuperAudit() {
  const [scope, setScope] = useState("");
  const q = useQuery({ queryKey: ["super-audit", scope], queryFn: () => api.get<any>(`/super/audit${scope ? `?scope=${scope}` : ""}`).then((d) => d.entries as any[]) });
  return (
    <div>
      <H title="Auditoria" sub="Trilha imutável das ações que movem dinheiro ou acesso. (Ações de donos nos próprios painéis ficam na auditoria da barbearia.)" action={
        <Select value={scope} onChange={(e) => setScope(e.target.value)} className="w-40"><option value="">escopos: todos</option><option value="platform">platform</option><option value="company">company</option></Select>} />
      {q.isLoading ? <Spinner /> : (
        <Table head={["Quando", "Quem", "Escopo", "Ação", "Alvo", "Payload"]}>
          {(q.data ?? []).map((e: any) => (
            <Tr key={e.id}>
              <Td className="whitespace-nowrap text-xs">{e.created_at?.slice(0, 19).replace("T", " ")}</Td>
              <Td className="text-xs">{e.actor_email ?? `#${e.actor_user_id ?? "sistema"}`}</Td>
              <Td><Badge tone={e.scope === "platform" ? "blue" : "gray"}>{e.scope}</Badge></Td>
              <Td className="font-mono text-[11px] text-zinc-200">{e.action}</Td>
              <Td className="text-xs">{e.entity}{e.entity_id ? `#${e.entity_id}` : ""}{e.company_id ? ` · co ${e.company_id}` : ""}</Td>
              <Td className="max-w-[360px] truncate font-mono text-[10px] text-zinc-500">{e.payload ?? ""}</Td>
            </Tr>
          ))}
        </Table>
      )}
    </div>
  );
}
