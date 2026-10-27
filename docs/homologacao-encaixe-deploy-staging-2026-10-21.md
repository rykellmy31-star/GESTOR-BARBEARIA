# TIGU — publicar encaixe antecipado somente no Worker de homologação

Migração 0020 aplicada com sucesso no banco **tigu-staging-db**, sem alterações em produção: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697427709

Bateria de testes do recurso 9h30–10h → fim às 9h45 → encaixe 15 min e proteção de sobreposição, browser e HTTP: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697191149

Este commit aciona exclusivamente `scripts/staging-update-ci.mjs` no Worker `tigu-staging` preexistente, preservando bindings D1/R2 e segredos. Nunca modificar Worker de produção, `main`, credenciais financeiras ou fazer merge.
