# TIGU — inventário real R2, somente leitura, após recuperação remota

A recuperação em novos recursos foi aprovada no Actions 39699187805. O banco D1 recuperado tem 43 tabelas e hashes iguais; o R2 recuperou apenas um objeto de prova, não o acervo completo.

O push `TIGU_R2_READONLY_INVENTORY_ONCE` é limitado a consultas GET da API Cloudflare ao bucket `tigu-staging-media` e ao destino `tigu-recovery-20261021-39699187805-r2`. Usa paginação por cursor e conta somente a quantidade agregada de objetos e bytes; não imprime chaves privadas, nomes, usuários, payloads, tokens ou arquivos. Aborta quando paginação estiver incompleta ou a API negar acesso.

Proibido criar, apagar, listar dados de produção, copiar objetos, sobrescrever backups, efetuar pagamentos ou alterar Worker/D1/R2. Apenas inventário em staging.
