# TIGU — Auditoria do inventário R2 em homologação (22/10/2026)

Solicitação: continuar a homologação do TIGU até 100% de segurança e funcionalidade, preservando produção, banco e arquivos.

Disparar **somente** o script existente `scripts/staging-r2-inventory-readonly.mjs` pelo gatilho exato `TIGU_R2_READONLY_INVENTORY_ONCE`.

Restrições: apenas GET de metadados com paginação, sem conteúdo/nome de arquivo nos logs, sem criar/alterar objetos ou buckets, sem reconfigurar secrets, sem custos desnecessários e sem alterar produção.

A verificação D1 anterior concluiu a exportação e restauração SQLite efêmera com `integrity:ok`, `foreign_keys:ok`; não equivale a um restore remoto e não prova integridade do R2.

Resultado esperado desta fase: inventário completo do R2 `tigu-staging-media` e destino de restauração de prova, identificando pendências para a cobertura integral.
