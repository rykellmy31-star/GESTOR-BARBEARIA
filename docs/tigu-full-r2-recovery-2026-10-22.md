# TIGU — recuperação integral R2 homologação, 22/10/2026

Solicitação explícita do proprietário: comprovar integralmente a recuperação de arquivos do R2, mantendo produção e staging de origem intactos.

Autorizar **somente** o script existente `scripts/staging-r2-full-recovery-ci.mjs` por meio do commit exato `TIGU_FULL_R2_ISOLATED_RECOVERY_ONCE`, branch `audit/tigu-primeira-validacao`.

Escopo:
- Origem: bucket existente `tigu-staging-media` do Worker `tigu-staging`.
- Verificar previamente o Worker, D1 e R2 de staging por APIs de leitura.
- Criar **bucket novo** com nome derivado do run ID, recusando qualquer destino preexistente.
- Volume permitido pelo script: até 500 objetos e 50 MiB; inventário anterior confirmou 7 objetos e 2.643 bytes.
- Ler objeto original, copiar para bucket novo sem sobrescrever nada, baixar a cópia, comparar hash SHA-256 de cada objeto, revalidar inventários e garantir origem estável.
- Não tocar nos buckets antigos de recuperação, nos dados de produção, nem no D1.
- Sem logs de nomes/conteúdo/chaves privadas, sem publicar artifacts de clientes e sem reter arquivos no runner.
- Como a criação/cópia pode consumir recursos faturáveis, usar volume mínimo demonstrado de staging e nenhum recurso além do isolado autorizado.
- Exigir resultado `all_source_objects_restored:true`, `sha256_per_object_verified:true`, `source_unchanged:true`, `production_modified:false`; caso contrário reportar bloqueio.

Isto valida cópia integral dos objetos em staging com hashes, não comprova restauração das demais configurações HTTP de metadados nem uma estratégia automática de backups recorrentes.
