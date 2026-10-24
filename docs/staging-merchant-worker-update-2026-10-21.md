# Homologação: publicar checkout por estabelecimento somente em tigu-staging

Migração 0019 aplicada isoladamente no tigu-staging-db:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39686595374

CI de testes, compilação, browser e HTTP aprovado:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39686204232

Disparar apenas `scripts/staging-update-ci.mjs`, garantindo atualização do Worker já existente `tigu-staging`, preservação de segredos e bindings D1/R2, nenhuma alteração em produção e `MERCHANT_PIX_ENABLED` ausente/desativado. Provedores reais permanecem bloqueados com `TIGU_STAGING=1`.

Não usar o fluxo de checkout deste Worker para cobranças reais; somente ensaios com dados fictícios.
