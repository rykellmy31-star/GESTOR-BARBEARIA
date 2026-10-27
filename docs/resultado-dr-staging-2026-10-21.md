# TIGU — resultado real da homologação de Disaster Recovery (21/10/2026)

**Escopo autorizado:** inspeção e comparação apenas de leitura em Cloudflare staging. Produção e contas financeiras não foram alteradas.

## Evidências executadas
- Inventário Cloudflare (GET): [Actions 39694221817](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39694221817), **sucesso**. Origem `tigu-staging-db` validada; banco e bucket `tigu-staging-restore-check` já existem. Nenhuma alteração, criação ou restauração.
- Comparador D1 de leitura com validações locais e Chromium: [Actions 39695288635](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39695288635), **sucesso**. Usa somente GET do inventário e **dois** `wrangler d1 export --remote` para arquivos efêmeros; compara tabelas e fingerprints. Nenhuma escrita remota.

## Resultado técnico
| Métrica | Fonte | Destino |
| --- | --- | --- |
| Tabelas | 43 | 40 |
| Estrutura de checkout 0018/0019 | completa | incompleta |
| SHA256 dos registros após export | **diferente** | **diferente** |
| Cloudflare restore do estado atual homologado | — | **NÃO** |

O destino existente é diferente da origem. A fonte atual passou em testes de integridade SQLite, chaves estrangeiras e exportação (Actions 39692905966). O destino **não** deve ser considerado backup recuperável atualizado.

### Proteções mantidas
- O ensaio **não** fez importação/restauração no D1 remoto nem sobrescreveu o destino existente.
- Nenhum bucket R2 foi alterado; recuperação completa de R2 ainda **não** foi comprovada. Upload/download da mídia fictícia no staging já passou, o que não equivale a restore em outro bucket.
- Branch `audit/tigu-primeira-validacao` e PR Draft preservados. `main` e Workers de produção intocados.
- Pix real, repasses, reembolsos e outros fornecedores não foram acionados.

## Bloqueio e decisão para o próximo passo
Como os destinos `tigu-staging-restore-check` já existem, scripts fail-closed recusam sobrescrevê-los. A homologação remota completa exige **novos destinos isolados**, com nomes únicos e sem qualquer alteração nos destinos anteriores, além de autorização específica do responsável para criação de recursos Cloudflare que podem ter custos. Alternativamente, autorização explícita e análise dos dados de destinos existentes antes de qualquer reaproveitamento; isso não é recomendado. Nunca substituir o banco original.

Após aprovação, criar D1/bucket novos isolados, exportar fonte, importar cópia no D1 novo, comparar fingerprints, ensaiar bytes SHA256 de arquivo fictício no R2 novo, executar rollback check e documentar final.
