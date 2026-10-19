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

## Etapa 3 — isolamento de webhooks e lembretes (19/10/2026)

- Recebimento de status da Meta exige `metadata.phone_number_id` conhecido e pertencente à mesma empresa do `message_jobs`. Eventos que apontem para outra empresa não modificam o job nem o saldo.
- Webhooks de entrega são idempotentes. Eventos de falha atrasados não rebaixam mensagens já entregues/lidas.
- Mensagem recebida do cliente NÃO define `whatsapp_optin=1` nem `lgpd_consent_at` automaticamente.
- A migração `0002_whatsapp_identity.sql` estabelece unicidade de `phone_number_id` não vazio entre empresas. Não alterar ou pular a migração ao preparar produção; bancos com identidades duplicadas precisam ser saneados.
- Novos testes verificam identidade do número entre empresas, webhook duplicado, status fora de ordem, opt-in explícito, programação exatamente 60 min antes, reagendamento idempotente, troca de versão e cancelamento com liberação de reserva.
- **GitHub Actions: 21/21 testes aprovados**, verificação TypeScript e build aprovados.
- Ainda faltam testes reais de entrega no provedor, revisão dos tokens de integração, simulação de perda/timeout de webhook e auditoria de consentimento no fluxo de cadastro público.


## Etapa 4 — recuperação de Pix (19/10/2026)

- A rotina `reconcilePendingTopups` verifica cobranças Pix recentes ainda não creditadas, inclusive recargas marcadas como expiradas, por meio do Mercado Pago. Não depende da entrega do webhook para confirmar pagamentos.
- O cron executa a reconciliação a cada 10 minutos, limitado a 20 cobranças por execução, e alterna os pedidos pela última verificação. A busca está limitada a pedidos criados nas últimas 48 horas para evitar consultas indefinidas.
- O valor, a referência, o método Pix, a moeda BRL e o identificador do pagamento são comparados com o pedido antes do crédito, usando as validações já existentes.
- O crédito continua protegido por transação D1 e chave de idempotência.
- Testes automatizados verificam duas aprovações válidas (uma após expiração), repetição sem dupla cobrança e rejeição de divergência de valor.
- Execução aprovada: 22/22 testes, checagem de tipos e build concluídos.

### Pendências de produção que continuam abertas

- WhatsApp: uma falha de rede ou timeout após enviar à Meta pode ser resposta indeterminada; o cron atual ainda pode repetir o disparo. Antes de usar números reais é necessário registrar/reconciliar resultados indeterminados sem reenviar automaticamente.
- Webhooks: o código atual responde HTTP 200 para algumas falhas de processamento, inclusive quando o evento não foi completamente persistido. Deve diferenciar evento concluído de erro transitório.
- Pix: a conciliação é limitada aos últimos dois dias, 20 registros por execução e depende da disponibilidade da API real; pagamentos mais antigos exigem investigação administrativa.
- O fluxo financeiro real e os estados da API ainda devem passar por testes ponta a ponta antes de receber clientes e dinheiro reais.
