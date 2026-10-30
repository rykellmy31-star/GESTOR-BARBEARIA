# TIGU — preparação da mensalidade manual (antes de integrar ao CR Jornada)

## Escopo e limites

Este trabalho foi criado **somente** em branch derivada de `audit/tigu-primeira-validacao`.
Não altera `main`, Cloudflare, banco de produção, Postos ou Farmácias. **Não é uma integração com admin.crjornada.com** ainda.

A única cobrança mudada é a **mensalidade de assinatura da plataforma TIGU**.
As rotas de Mercado Pago de pagamentos opcionais de profissionais (`seller-mercadopago`), recebimentos de barbearias (`merchant-mercadopago`), agendamentos e pedidos, recargas da carteira e a API WhatsApp não são removidas.

## Fluxos

1. `TIGU_PLATFORM_BILLING_MODE=manual` (padrão desta branch): proprietário vê planos Start, Pro, Scale e solicita plano, sem gerar Pix. Depois do vencimento, ainda consegue enviar a solicitação.
2. A solicitação entra em `subscription_plan_requests`, com uma única pendência por empresa; a solicitação **não ativa** a assinatura.
3. No Super Admin interno do TIGU, o responsável pode informar referência única, valor recebido **fora** da plataforma, plano, quantidade de meses e justificativa. `POST /api/super/companies/:id/manual-renew` aplica a renovação com proteção contra repetição, registra histórico e audita.
4. Bloqueio/reativação de barbearias e funcionalidades existentes permanecem no TIGU.
5. `TIGU_PLATFORM_BILLING_MODE=mercadopago` mantém o fluxo antigo de assinaturas apenas para rollback controlado; não habilitar sem autorização.
6. Faturas Pix de assinatura anteriores continuam consultáveis e conciliáveis. Não cancelar/descartar eventos pendentes emitidos antes da transição.

## Migração D1 e segurança

- Migração **aditiva**: `migrations/0103_manual_platform_subscriptions.sql`. Não aplicar em produção antes de backup, homologação e autorização.
- Histórico de recebimentos externos: `manual_subscription_renewals`, referência exclusiva por barbearia. Não movimenta dinheiro, carteira WhatsApp ou gateway.
- Somente sessão de proprietário pode solicitar plano; **somente Super Admin do TIGU** pode registrar renovação.
- A validação do backend impede geração de novos Pix da mensalidade no modo manual, inclusive por requisições diretas.
- Não enviar credenciais/tokens nem comprovantes sensíveis para o GitHub.
- Futura central `admin.crjornada.com` deve acessar o TIGU via API administrativa autenticada com escopo, auditoria e idempotência, não pelo banco D1.

## IMPORTANTE — WhatsApp e cobranças de mensagens

As credenciais da Meta são configuradas por barbearia; porém o TIGU **também** possui atualmente carteira de créditos e tarifas próprias por mensagem. O usuário quer que a contratação da API e seus custos sejam do proprietário. A política de carteira/recargas precisa ser auditada e validada separadamente **antes** de qualquer mudança, pois não faz parte da cobrança da mensalidade e foi expressamente exigido preservar as funcionalidades já existentes.

## Homologação obrigatória antes da integração central ou produção

- Rodar `npm ci`, `npm run check:types`, `npm test`, `npm run build` e `node scripts/local-e2e.mjs` no ambiente isolado.
- Aplicar a migração 0103 **somente** no D1 staging isolado; verificar a ausência de perdas de dados e rollback de código.
- Confirmar seleção e solicitação de plano com assinatura ativa e expirada, sem Pix.
- Verificar aplicação manual do plano com referência idempotente (retry não estende prazo) e concorrência.
- Verificar acesso negado a um proprietário de outra empresa e a qualquer pessoa sem role Super Admin.
- Confirmar o fluxo opcional do Mercado Pago dos profissionais e webhooks `/seller-mercadopago` e `/merchant-mercadopago`; verificar que ambos operam sem interferência.
- Confirmar recargas, histórico de Pix anteriores e webhooks de pagamentos emitidos antes da transição.
- Confirmar agendamentos, WhatsApp, períodos de teste, bloqueios e dados existentes.
- Criar integração central apenas em etapa posterior e **com autorização separada**.
