# Tigu — Cobrança mensal Pix por Mercado Pago

## Situação da integração

A API de cobrança **está implementada no código**. Isso não significa que o pagamento real esteja ativo: ainda é preciso configurar a conta Mercado Pago, migrar o D1, fazer testes com valores e credenciais de teste e publicar o Worker autorizado. A branch principal `main` não deve ser alterada antes de homologação aprovada.

**Atenção:** *Pix mensal por iniciativa do cliente* é diferente de *Pix Automático com autorização prévia*. Esta etapa implementa o primeiro modelo. Nenhum pagamento é debitado sozinho, e não há acesso a contas bancárias do cliente.

## Como funciona

1. Cliente cadastra sua barbearia e começa um teste grátis de **15 dias**.
2. O painel mostra a data de vencimento. Após essa data, novas operações são bloqueadas, mas os dados continuam para consulta.
3. Proprietário abre **Painel da barbearia → Assinatura e Pix**. O Tigu consulta no D1 o preço vigente do plano Start, Pro ou Scale.
4. O botão **Gerar Pix** cria uma única fatura de assinatura no D1 e chama **POST /v1/payments** do Mercado Pago. A fatura possui código aleatório único; o pagamento tem chave de idempotência.
5. O cliente paga pelo QR Code ou Pix Copia e Cola em seu banco.
6. O Mercado Pago notifica `POST /api/webhooks/mercadopago` usando assinatura; o Tigu reconsulta **GET /v1/payments/{id}** com o Access Token secreto.
7. Só aprova se o pagamento tiver **status approved, ID exato, referência própria da fatura, moeda BRL, método pix e valor idêntico**. Então o D1 registra a fatura como paga e soma **um mês** ao prazo da assinatura, numa transação idempotente. Pix repetido/reentregue não ganha vários meses.
8. Cron de produção reconsulta periodicamente Pix pendentes para recuperar webhooks perdidos. Na homologação o cron fica **desligado**.

O caminho `/api/c/:slug/billing` exige sessão e vínculo de proprietário à respectiva barbearia. A fatura da assinatura fica em `subscription_invoices` (migração `0005_subscription_pix.sql`), **separada de `topup_orders`**, que continua sendo exclusivamente recarga de créditos WhatsApp.

## Preparar a conta Mercado Pago

1. Entre em <https://www.mercadopago.com.br/developers/panel/app> e crie uma aplicação associada à sua conta Mercado Pago; consulte *Suas integrações*.
2. Nas credenciais da aplicação, obtenha o **Access Token** do ambiente apropriado. Mantenha-o **somente no secret do Cloudflare Worker**. Nunca envie tokens em mensagem, screenshot, commit, site público ou variável `VITE_*`.
3. Em Webhooks, configure a URL HTTPS **`https://SEU_DOMINIO/api/webhooks/mercadopago`** para notificações de pagamentos e guarde a assinatura secreta da integração.
4. No Worker de produção, configure **`MP_ACCESS_TOKEN`**, **`MP_WEBHOOK_SECRET`**, **`PUBLIC_URL`** com domínio HTTPS e **`SESSION_SECRET`** forte. Na Cloudflare: Worker → Settings → Variables and Secrets (ou `wrangler secret put` com configuração de produção explicitamente revisada).
5. Mantenha **`TIGU_STAGING` ausente/0**, **`PAYMENTS_MOCK` ausente/0**, `APP_ENV=production` somente após cumprir todos os demais testes. Nunca copie tokens produtivos para a homologação.
6. Rode migrations na instância **D1 correta**, inclusive `0005_subscription_pix.sql`. Não execute migrations na produção antes de aprovar o plano de backup/rollback.
7. Teste valor correto, Pix pendente, aprovado, cancelado, pagamento duplicado, nova mensalidade, indisponibilidade do gateway, falsificação de webhook e tentativas de uma empresa acessar a cobrança de outra.
8. Verifique extratos e webhooks no painel do Mercado Pago. Uma tela de sucesso, botão "Já paguei" ou comprovante enviado pelo cliente **não comprova pagamento**.

## Segurança e limitações

- `APP_ENV=production` e `TIGU_STAGING=1` **bloqueiam chamadas Pix reais no ambiente de homologação**, mesmo com token.
- A suite de testes automatizados simula o gateway por HTTP falso e **não envia dinheiro**.
- Assinatura mensal **não alimenta a carteira** de mensagens WhatsApp. Recarregá-la continua sendo um Pix separado.
- Não há cartão salvo ou autorização de débito recorrente automático; é preciso gerar/pagar um Pix no vencimento de cada mês.
- A integração de **Pix Automático** do Mercado Pago pode demandar produto, habilitação e consentimento específicos. Não confundir com o fluxo de Pix QR Code criado aqui.
- Antes da liberação comercial, testar tratamento de pagamentos devolvidos, estornos/chargebacks, Pix atrasados, inconsistência de rede entre Mercado Pago e D1, expiração e suporte. Integração implementada não substitui homologação financeira real.

Docs oficiais: <https://www.mercadopago.com.br/developers/pt/docs/checkout-api-payments/integration-configuration/integrate-pix> e <https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/payment-notifications>.
