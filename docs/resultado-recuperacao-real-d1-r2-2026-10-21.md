# TIGU — resultado comprovado de Disaster Recovery remoto (21/10/2026)

## Resultado executivo

Execução real **aprovada** do GitHub Actions:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39699187805

Foi aplicada uma recuperação em **recursos novos**, criados com autorização do proprietário, depois de validar a identidade de staging. A produção e os recursos preexistentes permaneceram intactos. Não houve merge na `main`.

| Componente | Evidência | Resultado |
| --- | --- | --- |
| Fonte D1 | `tigu-staging-db` | íntegra |
| Destino D1 NOVO | `tigu-recovery-20261021-39699187805-d1` | SQL restaurado na Cloudflare |
| Banco D1 | 43 tabelas, contagem de dados comparada | SHA-256 dos registros idêntico; integridade e FKs corretas |
| Fonte R2 | `tigu-staging-media` | somente arquivo aleatório de prova em prefixo reservado |
| Destino R2 NOVO | `tigu-recovery-20261021-39699187805-r2` | cópia do arquivo verificada byte a byte por SHA-256 |
| Proteção | `tigu-staging-restore-check` antigo | sem sobrescrita |
| Produção | `main`, Workers e D1/R2 de produção | sem alterações |

O resultado da ação remota registrou
`cloudflare_restore_verified: true` para o banco,
`tables: 43` e `checksums_match: true`.
A ação R2 registrou `objects_verified: 1`,
`cloudflare_r2_restore_verified: true` e explicitamente
`all_bucket_objects_copied: false`.

**Limitação importante:** o ensaio R2 comprova a recuperação de um objeto binário de prova, **não** a cópia integral de todos os arquivos de clientes nem a capacidade de restaurar qualquer ponto histórico. Os dumps SQL do ensaio foram apagados do runner; o próprio destino D1 de recuperação permanece na Cloudflare.

## Outras evidências

- Migração `0020_last_minute_fit_in.sql` no D1 de homologação: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697427709
- Worker de homologação atualizado com saúde e segredos preservados: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697805090
- 37 verificações remotas autenticadas, incluindo encaixe de 15 min e rejeição de sobreposição: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39698839958
- PR #1 Draft, sem merge.

## Pendências que impedem 100%

1. Inventário e teste de recuperação do **acervo completo** R2, com manifesto/contagem de objetos, evitando expor arquivos ou dados pessoais.
2. Política efetiva de backups recorrentes, retenção, restauração e simulação de desastre por período.
3. Testes com credenciais comerciais **sandbox** Mercado Pago por empresa, Pix/estorno, validação de webhook, expiração e reprocessamento, sem cobranças reais involuntárias.
4. Revisão final de acesso por perfil, segurança, concorrência, controle de gastos e documentação de produção.
5. Publicação de produção somente após checklist e aprovação explícita do momento da liberação.

Os recursos de recuperação criados podem consumir cota. **Não apagá-los automaticamente**: servem como evidência até decisão de retenção/limpeza. Nenhum token, contato ou exportação SQL foi publicado neste documento.
