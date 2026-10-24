# TIGU — tentativa controlada de ativar Turnstile da captação comercial

Solicitação explícita do proprietário em 22/10/2026: ativar proteção antirobôs do formulário de interessados no site TIGU, preservando produção e todas as credenciais existentes.

## Autorização restrita a esta única execução

Gatilho exato: `TIGU_TURNSTILE_STAGING_SETUP_ONCE` na branch `audit/tigu-primeira-validacao`.

- Antes de escrever, conferir por API recursos `tigu-staging`, `tigu-staging-db` e `tigu-staging-media`, o valor literal `TIGU_STAGING=1`, bindings e widgets existentes.
- Requer token com `Account:Turnstile:Edit` ou `Turnstile Sites Write`. Se não houver permissão, **parar sem alterar nada** e relatar o ajuste de acesso necessário.
- Se já houver qualquer binding Turnstile no Worker, **parar sem sobrescrever**.
- Se já houver widget com nome reservado, **parar sem criar duplicata**.
- Criar apenas um widget Turnstile Managed para `agendamentos.crjornada.com` e `tigu-staging.netssh3-0.workers.dev`.
- Instalar seus 2 valores exclusivamente como secrets `SALES_TURNSTILE_SECRET` e `SALES_TURNSTILE_SITE_KEY` no Worker `tigu-staging`, nunca em repositório, log ou D1.
- Exigir testes locais de segurança antes do provisionamento, e conferir endpoints /api/health e /api/marketing/lead-config depois.
- Nenhuma alteração de pagamentos Mercado Pago, WhatsApp real, crons, produção, D1/R2, contatos comerciais ou plano do cliente.

Scripts: `scripts/staging-turnstile-setup.mjs` e testes `scripts/staging-turnstile-setup.node.test.mjs`.

O serviço de contato comercial requer endereço ou telefone autorizado pelo titular; **não publicar automaticamente o e-mail de login do Super Admin como contato público**.

Este passo NÃO constitui homologação dos gateways financeiro/Meta nem libera os envios reais.
