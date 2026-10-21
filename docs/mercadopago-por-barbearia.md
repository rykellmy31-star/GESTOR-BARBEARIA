# Recebimentos de cada barbearia — Mercado Pago próprio

## Quem recebe
Serviços (corte, barba, etc.) e produtos: **100% da cobrança é criada usando o Access Token do próprio dono**, conectado em *Painel da barbearia → Configurações → Mercado Pago da barbearia*. Não há split, repasse intermediado ou uso do Access Token financeiro TIGU. Taxas comerciais cobradas pelo Mercado Pago pertencem ao acordo do vendedor com o provedor.

Os recebimentos de clientes NUNCA utilizam `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `topup_orders`, `subscription_invoices` ou o saldo da carteira de mensagens. Os dois últimos continuam exclusivamente sob a conta da PLATAFORMA.

## Configuração pelo dono
1. Abrir sua conta Mercado Pago e criar aplicação em *Suas integrações*, com credenciais próprias de produção.
2. No painel da sua barbearia, informar *Access Token* privado e *chave secreta Webhook*. Somente usuário com papel `owner` pode acessar, alterar e remover.
3. O servidor consulta `GET /users/me` com **esse token** e persiste ID de recebedor e credenciais cifradas AES-256-GCM usando `MSG_ENC_KEY`. O token jamais retorna em GET.
4. Copiar a URL Webhook exclusiva da empresa mostrada pelo painel e associar ao evento `payment` na aplicação Mercado Pago.
5. A plataforma pode liberar o recurso globalmente com `MERCHANT_PIX_ENABLED=1` **apenas na produção**, após testes e aprovação. Esta variável é uma chave de segurança, não o recebedor.
6. No checkout, cliente escolhe *pagar depois* ou *pagar agora com Pix*. O valor vem de `services.price_cents` (agendamento) ou itens `products.price_cents` lidos no servidor (produto).
7. Pagamento só vira `paid` após consulta `GET /v1/payments/{id}` na conta daquele vendedor, verificando `external_reference`, `currency_id=BRL`, `payment_method_id=pix`, valor, identidade de beneficiário quando disponível e status `approved`.

## Segurança e operação
- `company_payment_integrations`: credenciais por `company_id`, chave aleatória exclusiva na URL do Webhook. O segredo Webhook é cifrado no D1 e seu HMAC validado antes da conciliação.
- `booking_payments` e `order_payments` não atualizam mensalidades, topups ou carteira da plataforma.
- O painel não pode marcar manualmente como pago um pedido Pix; confirmação é automática e idempotente.
- Alteração/desconexão de conta com cobrança `creating`, `pending` ou `refund_required` é bloqueada também no D1.
- Se o cliente cancelar após pagar, marcar `refund_required`. **Estorno automático não está implementado**: o proprietário deve conciliar o reembolso.
- Evitar cobranças duplicadas: chaves idempotentes de agendamento, pedido e cobrança. Respostas incertas do provedor não autorizam emitir novo Pix.
- O ambiente `tigu-staging` sempre rejeita pagamentos reais e configuração de credenciais reais. Não publicar em produção sem passar CI e aplicar migração `0019_merchant_payments.sql` ao banco correto.
- Atenção: pedidos de produtos aguardando Pix ainda utilizam reserva de estoque padrão do site; há necessidade de uma política comercial para tempo máximo de retirada/cancelamento de pedidos não pagos.

Documentação oficial Mercado Pago: https://www.mercadopago.com.br/developers/pt/docs/checkout-api/payment-integration-pix e https://www.mercadopago.com.br/developers/pt/docs/loja-integrada/additional-content/your-integrations/notifications/webhooks.
