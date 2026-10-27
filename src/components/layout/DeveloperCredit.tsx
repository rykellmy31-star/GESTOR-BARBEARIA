/**
 * Crédito de desenvolvimento compartilhado por todas as rotas do Tigu.
 * Uma única instância após o roteador cobre home, prévia, áreas públicas e painéis.
 */
export const DEVELOPER_CREDIT = "Sistema desenvolvido por Carlos Rykellmy Santos Correia";

export function DeveloperCredit() {
  return (
    <footer
      className="relative z-10 border-t border-[#26262f] bg-[#0e0e12] px-4 py-4 text-center text-[11px] leading-relaxed text-zinc-500 sm:text-xs"
      aria-label="Créditos de desenvolvimento do sistema"
    >
      <span className="block">
        Sistema desenvolvido por{" "}
        <span className="font-medium text-zinc-300">Carlos Rykellmy Santos Correia</span>
      </span>
    </footer>
  );
}
