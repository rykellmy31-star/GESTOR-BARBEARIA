# MIGRAÇÃO APROVADA — recebimentos por barbearia, staging

CI de segurança, compilação, testes HTTP, browser e isolamento aprovado:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39686204232

Execução deste commit: exclusivamente `scripts/staging-booking-migrate-ci.mjs`, com identidade de Cloudflare staging conferida e `wrangler d1 migrations apply ... --remote` no `tigu-staging-db` existente.

Apenas a migração pendente `0019_merchant_payments.sql` será aplicada; `0018` já aplicada. A tabela por barbearia guarda credenciais cifradas e o checkout de produtos passa a ter recebimento independente do TIGU.

Sem criar recursos, sem apagar dados, sem mexer no D1/R2 de produção, sem habilitar Pix de cliente nem modificar assinatura e recarga.
