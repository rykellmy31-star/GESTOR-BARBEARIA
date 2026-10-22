# TIGU — autorização de restauração integral R2 em novo bucket exclusivo

**Origem** `tigu-staging-media` (exclusivamente homologação) e **destino novo** `tigu-recovery-full-20261021-<GITHUB_RUN_ID>-r2`, exclusivo da execução.

Inventário remoto somente leitura do acervo: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39700970822 — origem **7 objetos, 2.643 bytes**; bucket de prova anterior **1 objeto, 1.045 bytes**. Os anteriores ficam intactos.

A restauração isolada anterior do D1 (43 tabelas, integridade e SHA-256) e do objeto R2 foi aprovada: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39699187805

Autorização expressa do usuário para criar os recursos necessários de homologação na Cloudflare, incluindo potencial custo de armazenamento/operações. **Gatilho único:** `TIGU_FULL_R2_ISOLATED_RECOVERY_ONCE`. A ação só pode prosseguir depois de compilar e aprovar todos os testes do CI. Antes de criar bucket, exige identidade Cloudflare staging, inventário integral paginado, quantidade e tamanho limitados e destino inexistente. Copia bytes da origem ao destino novo sem expor chaves, valida SHA-256 de todos os objetos, compara inventário antes/depois para detectar mutações durante o ensaio.

Proibido publicar em produção, deletar arquivos ou bancos anteriores, mexer em tokens, enviar mensagens reais, cobrar clientes ou sobrescrever buckets existentes. Destino novo será preservado para auditoria até autorização de limpeza.
