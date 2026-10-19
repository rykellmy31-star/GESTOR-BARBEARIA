# Tigu — Relatório de auditoria inicial (19/10/2026)

> Auditoria técnica da branch `audit/tigu-primeira-validacao`. **Não é autorização para deploy comercial.**

## Situação validada

- Código-fonte extraído do arquivo `tigu.zip`, apenas nesta branch.
- CI GitHub Actions realiza `npm ci`, auditoria das dependências de produção (nível high), TypeScript, `npm run build` e `npm test`.
- 17 testes automatizados passaram no ambiente Cloudflare Workers (16 originais + 1 teste de fluxo financeiro).
- GitHub Actions passou na branch depois das correções realizadas; revisar execuções a cada novo commit.
- `npm audit --omit=dev --audit-level=high` passa, mas informa **duas vulnerabilidades moderadas** associadas ao React Router 6. Atualização principal sugerida é major e deve ser testada antes.
- A instalação geral de dependências ainda relata **18 alertas** (5 moderados, 11 altos, 2 críticos), sobretudo na árvore de desenvolvimento. Exige triagem pacote por pacote antes da liberação.

## Correções realizadas

1. Ajuste manual de saldo: movimentação e lançamento no extrato feitos atomicamente via D1 batch; chave de idempotência impede reaplicação da mesma operação.
2. Crédito por Pix: valor conferido com o pedido persistido, lançamento e atualização de saldo/status em uma transação; repetição não adiciona crédito.
3. Confirmação de pagamento real: exige `status=approved`, `payment_method_id=pix`, `currency_id=BRL`, valor exato, `external_reference` e ID iguais ao pedido local. Rejeita divergências.
4. Reserva de saldo para mensagens: atualiza efetivamente `message_jobs.reserved_cents`, registra reserva no extrato e usa checks do banco para impedir saldos indisponíveis.
5. Liberação de reserva: realizada com o lançamento e baixa de reserva na mesma transação; remoção de resets prematuros que impediam estornos.
6. Captura de cobrança e reembolso: operações atomizadas e protegidas por `idempotency_key`.
7. Mensagens avulsas/de teste: corrigido o descarte indevido de jobs sem agendamento vinculado.
8. Reprocessamento de agendamento: não cancela o lembrete da mesma versão quando reexecutado.

## Bloqueios de produção

- `wrangler.jsonc` ainda tem D1 `REPLACE_WITH_YOUR_D1_DATABASE_ID`, `APP_ENV=development` e recursos Cloudflare não configurados. **Não usar `npm run deploy` para um serviço público com esses valores.**
- Ainda não foram feitos testes end-to-end com contas e credenciais reais do Mercado Pago e da Meta.
- A autorização de múltiplos números e o faturamento centralizado dependem de contrato/permissões do fornecedor; o código atual integra principalmente a Cloud API da Meta.
- Testes atuais não cobrem todos os fluxos sob concorrência real, operações com múltiplas barbearias em paralelo, webhooks fora de ordem, recuperação após timeout do provedor e políticas de LGPD.
- Auditar permissões para disparos de teste/avulsos e o consentimento do destinatário antes de habilitá-los em produção.
- Revisar as duas vulnerabilidades moderadas do React Router; não executar `npm audit fix --force` sem testar mudanças de versão.
- Avaliar reforço de idempotência ponta a ponta em requisições HTTP de ajustes financeiros, além da proteção do ledger.

## Próximos passos sugeridos

1. Ampliar testes de reserva/cancelamento/remarcação, webhooks e concorrência D1.
2. Investigar e corrigir alertas de dependências.
3. Preparar configuração separada para produção com todos os segredos no Cloudflare Workers, nunca no Git.
4. Configurar Meta/Gupshup e Pix em ambiente de testes com contas reais e validação de contratos de serviço.
5. Auditar segurança final, aplicar migrations e fazer deploy **somente** após aceite explícito.

## Garantias e limitações

- Código foi modificado **somente** na branch de auditoria do repositório `GESTOR-BARBEARIA`.
- A branch `main` e o projeto CR Jornada não foram alterados.
- Build e testes automatizados aprovados não substituem validação comercial, financeira e de entrega real do WhatsApp.
