# TIGU — comparação D1 remota, somente leitura, 21/10/2026

A inspeção Cloudflare GET confirmou que os dois destinos de recuperação pré-existem, portanto é proibido executar restauração neles sem autorização de substituição (não autorizada).

Comparador e regressões automatizadas aprovadas:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39694994963

Este push com gatilho `TIGU_D1_READONLY_COMPARE_ONCE` autoriza SOMENTE:
1. Inventário Cloudflare via GET para confirmar origem/destino D1.
2. `wrangler d1 export --remote` para `tigu-staging-db` e `tigu-staging-restore-check`, exclusivamente arquivos efêmeros do runner.
3. Comparar integridade, tabelas de checkout 0018/0019, quantidade de tabelas e hashes dos registros.
4. Excluir os SQL temporários sem publicá-los.

NÃO importar, criar, modificar, excluir recursos ou tocar em produção. Se os hashes diferirem, relatar `cloudflare_restore_verified:false` e não emitir falso sucesso.
