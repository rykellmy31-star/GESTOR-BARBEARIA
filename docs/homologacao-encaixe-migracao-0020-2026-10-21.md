# TIGU — aplicar migração de encaixes somente em homologação

**CI aprovado:** https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697191149. Os testes de código, concorrência, HTTP e Chromium passaram, inclusive cenário 9h30–10h finalizado 9h45 com encaixe de 15 minutos.

Este commit dispara apenas a etapa controlada `TIGU_MIGRATE_BOOKING_STAGING_ONCE`. O script `staging-booking-migrate-ci.mjs` valida a identidade Cloudflare Worker/D1/R2 e aplica migrações SQL ainda pendentes exclusivamente no D1 `tigu-staging-db`: adição `0020_last_minute_fit_in.sql` (metadados sem perda de reservas antigas).

Não recriar banco, não modificar D1/R2 de produção, não habilitar Pix, não fazer merge, não publicar Worker antes do esquema estar atualizado.
