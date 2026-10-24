# TIGU — disaster recovery real em novos D1/R2 isolados — autorização 21/10/2026

O titular autorizou expressamente a criação de um novo banco D1 e um novo bucket R2 de recuperação, inclusive eventuais custos inerentes ao ensaio, para concluir a homologação sem sobrescrever recursos anteriores.

Pré-requisitos:
- Worker `tigu-staging` atualizado e saudável, `production_modified:false`: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697805090
- Migração `0020` concluída no `tigu-staging-db`: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697427709
- 37 verificações remotas autenticadas, inclusive encaixe fora da grade, concorrência e bloqueio Pix real: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39698839958
- Bancos e bucket antigos `tigu-staging-restore-check` já contêm dados: proibido sobrescrevê-los.

**Ação única de DR:** gatilho `TIGU_NEW_ISOLATED_RECOVERY_ONCE` cria nomes únicos derivados exclusivamente do `GITHUB_RUN_ID`: `tigu-recovery-20261021-<run>-d1` e `tigu-recovery-20261021-<run>-r2`. Só usa o Worker/D1/bucket `tigu-staging` como origem. Antes de criar, confirma identidade staging, exporta D1, valida integridade e recusa destinos preexistentes. Importa no D1 novo, reexporta, compara hash dos registros e integridade. R2 copia um objeto BINÁRIO FICTÍCIO para bucket novo e verifica SHA-256 byte a byte; **isso não é cópia de todo o acervo R2**.

Não fazer merge, não alterar produção, não fazer cobranças, não deletar D1/R2 antigos. Guardar logs sem dados pessoais, tokens, SQL nem objetos reais. Falhas devem permanecer visíveis, sem falso sucesso.
