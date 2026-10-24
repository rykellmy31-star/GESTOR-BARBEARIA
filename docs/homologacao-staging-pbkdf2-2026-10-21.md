# TIGU — atualização isolada do Worker de homologação

Em 21/10/2026 foi autorizada a atualização exclusivamente do Worker `tigu-staging`, via gatilho controlado do CI.

- Branch: `audit/tigu-primeira-validacao`
- Código base inspecionado: `c9d8cb2dedc34f1ea617ad8e02afa44861adb3fa`
- Motivo: publicar o ajuste PBKDF2 de 100.000 iterações WebCrypto e suporte aos hashes legados de 150.000 via node:crypto.
- Fluxo permitido: `scripts/staging-update-ci.mjs`
- Exclusões: sem criação/recriação de D1, sem alterações em R2, sem migrations, sem rotação de `SESSION_SECRET` ou `MSG_ENC_KEY`, sem intervenção na produção ou na `main`.
- Verificação posterior obrigatória: GitHub Actions, health público e jornada autenticada remota fictícia.
- A atualização não equivale à homologação funcional e qualquer erro de cadastro deverá ser investigado antes da comercialização.

Este arquivo fornece rastreabilidade ao commit de acionamento único sem alterar código de produção.
