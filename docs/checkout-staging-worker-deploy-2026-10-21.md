# TIGU — deploy exclusivo do checkout no Worker staging

21 de outubro de 2026.

A migração 0018 foi aplicada e aprovada no **tigu-staging-db** pela execução:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39676022945

O fluxo atualizará apenas o Worker pré-existente `tigu-staging` por `scripts/staging-update-ci.mjs`, sem alteração dos segredos `SESSION_SECRET` e `MSG_ENC_KEY`, sem migrações adicionais, sem criar D1/R2 e sem alterar produção.

O checkout Pix para serviços continuará bloqueado em staging. O objetivo é homologar o fluxo de pagar após o serviço, verificar que a cobrança Pix real está indisponível e executar o restante das jornadas remotas fictícias.

Não fazer merge na `main`.
