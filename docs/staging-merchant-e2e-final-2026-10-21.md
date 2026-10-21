# Homologação remota final — Mercado Pago da própria barbearia

CI de código completo e migração 0019 aprovados. Worker isolado atualizado:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39686894567

Disparo único de `scripts/staging-auth-e2e.mjs` no `tigu-staging` com duas empresas e clientes fictícios. Exercita agendamento, estoque, pedidos, separação multiempresa, consulta de conta Mercado Pago pelo proprietário, recusa de token real de cliente e webhook fora de produção.

Sem cobrança Pix real, sem migração extra, sem produção e sem dados de clientes reais.
