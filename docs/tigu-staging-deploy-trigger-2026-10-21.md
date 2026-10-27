# TIGU — Atualização isolada do Worker de homologação

Este commit aciona exclusivamente o fluxo já existente `TIGU_UPDATE_WORKER_STAGING_ONCE` em GitHub Actions.

## Escopo
- Aplicação `tigu-staging` (sem alterar produção).
- Banco D1 e bucket R2 existentes, sem migrations nem recriação.
- Segredos atuais do Worker preservados.
- Novas páginas do Super Admin: Integrações e exclusão protegida de barbearias fictícias.
- Provedores reais de Mercado Pago e WhatsApp permanecem desativados no staging.

## Aceitação
Confirme conclusão da etapa `Atualizar Worker staging preservando segredos` e o GET `/api/health` depois da publicação. O botão de exclusão nunca pode apagar barbearias reais ou registros com histórico financeiro.

Esta documentação não contém credenciais.
