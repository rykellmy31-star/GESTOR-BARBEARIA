# TIGU — exportação e verificação de dados fictícios no D1

Data: 21 de outubro de 2026.

Este commit aciona somente o script `scripts/staging-d1-export-verify.mjs`, que:

1. Verifica o alvo `tigu-staging-db` na conta conectada.
2. Exporta SQL somente-leitura do D1 remoto de homologação.
3. Importa em SQLite temporário no GitHub runner.
4. Valida tabelas, integridade, chaves estrangeiras e contagens.
5. Descarta o arquivo SQL sem publicá-lo em artefatos.

Motivo da repetição: a homologação autenticada de https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39670087258 criou duas empresas fictícias, serviços, agendamento e pedido, permitindo avaliar recuperação lógica sobre dados representativos.

**Não** realiza restauração em outro recurso D1 Cloudflare e **não** modifica nem recria os destinos `tigu-staging-restore-check`. Não envolve produção ou mídias R2.
