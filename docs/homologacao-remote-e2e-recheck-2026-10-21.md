# TIGU — revalidar jornadas remotas após o backup do D1

Validação remota read-only e integridade SQLite passou em https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39692905966.

Disparo controlado de 33 verificações autenticadas de ponta a ponta no Worker `tigu-staging`: 2 barbearias fictícias, isolamento, dono, catálogo, agendamento presencial, pedido, recuperação do estoque, mídia R2 e bloqueio de pagamentos reais. O script usa dados fictícios, não efetua cobranças, não modifica produção, nem apaga dados existentes.

A restauração completa Cloudflare D1/R2 e pagamentos reais ficam fora do escopo até haver isolamento e aprovação comercial explícita.
