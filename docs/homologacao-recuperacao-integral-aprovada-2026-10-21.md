# TIGU — resultado final de recuperação remota D1 + R2 (21/10/2026)

## Resumo auditável

**Banco de dados D1: recuperação remota integral APROVADA.**
- GitHub Actions: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39699187805
- Fonte: `tigu-staging-db`.
- Destino NOVO: `tigu-recovery-20261021-39699187805-d1`.
- 43 tabelas restauradas na Cloudflare, integridade SQLite e chaves estrangeiras válidas, contagens e impressão SHA-256 idênticas ao export da origem.
- Origem, `main` e bancos de produção preservados.

**R2: recuperação integral dos objetos do ambiente de homologação APROVADA.**
- Inventário GET paginado: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39700970822
- Fonte `tigu-staging-media`: **7 objetos, 2.643 bytes**. Destino anterior de prova: somente 1 objeto.
- Restauração integral real: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39701677363
- Bucket NOVO: `tigu-recovery-full-20261021-39701677363-r2`.
- Copiados e recuperados **7/7 objetos**, **2.643/2.643 bytes**.
- SHA-256 conferido **individualmente** para cada arquivo após download da cópia no destino.
- Inventários da origem antes/depois sem mudanças; inventário final do destino idêntico em chave e tamanho.
- Content-Type preservado quando existente. Outros metadados HTTP, custom metadata, storage class e ACL **não foram validados**; não declarar paridade integral de metadados sem este teste.
- Chaves de objetos não foram expostas em logs; SQL D1, tokens e arquivos não foram publicados como artefatos.

## Recursos mantidos

- `tigu-staging-db` e `tigu-staging-media` não foram substituídos.
- `tigu-staging-restore-check` (D1 e R2) e `tigu-recovery-20261021-39699187805-r2` anteriores permaneceram intactos.
- D1 novo `tigu-recovery-20261021-39699187805-d1` e R2 novo `tigu-recovery-full-20261021-39701677363-r2` permanecem para comprovação. Podem gerar custos de cota/armazenamento; sem exclusões automáticas.
- Nenhuma cobrança, conexão Mercado Pago real, mudança de segredos, modificação em produção, merge do PR Draft ou migração de `main`.

## Homologação complementar da agenda

- Migração aditiva `0020_last_minute_fit_in.sql` aplicada no staging:
  https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697427709
- Worker `tigu-staging` atualizado:
  https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697805090
- 37 verificações reais autenticadas (barbearias fictícias, encaixe de 15 min fora da grade, rejeição HTTP 409 por sobreposição, cancelamento de reservas de teste, segurança/tenant):
  https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39698839958

## Pendências antes de produção

1. Configurar política de backups recorrentes e retenção, alertas e testes de recuperação periódicos, RPO/RTO aceitos e reversão.
2. Homologar não apenas dados, mas metadados, compatibilidade de conteúdo servido e política de acesso aos objetos R2.
3. Integração Mercado Pago com credenciais de TESTE por barbearia: cobranças Pix e produtos, confirmação/webhook, atraso, dupla notificação, falha, estorno e conciliação; respeitar isolamento do caixa TIGU.
4. Checklist de segurança de produção (acesso por perfil, segredo, rate limiting, logs, custo, rastreabilidade) e aprovação explícita da liberação em produção.
5. Deploy da versão de homologação somente após autorização do momento da publicação, proteção do Worker/D1/R2 atuais e política de rollback.

**Este documento registra ações executadas, não representa uma publicação comercial do TIGU.**
