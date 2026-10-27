# TIGU — homologação remota do checkout de serviços em 21/10/2026

Pré-requisitos comprovados:
- Migração 0018 no D1 staging: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39676022945 (sucesso; D1 de produção intocado).
- Worker atualizado preservando segredos: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39676463504 (sucesso).

Gatilho autorizado: `TIGU_AUTH_STAGING_E2E_ONCE`, executando `scripts/staging-auth-e2e.mjs` apenas em `tigu-staging`.

Testes adicionais: opção de pagamento posterior ativada, preço fixo igual ao serviço do D1, tentativa de pagar por Pix online bloqueada com HTTP 503 sem consumir o horário, além de duas empresas fictícias, isolamento, agenda, pedido/estoque e R2.

Não habilitar `BOOKING_PIX_ENABLED`, não fazer cobrança real, não criar recursos nem migrar produção.
