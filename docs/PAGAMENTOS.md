# Pix (Mercado Pago) na Tigu — recarga de créditos

> Crédito em carteira **só** entra com pagamento confirmado. O botão “Simular pagamento aprovado” existe
> apenas onde `PAYMENTS_MOCK=1` (ou empresa `demo=1`) e é rotulado como simulação na UI e no extrato.

## 1. Fluxo completo

```
Dono › Carteira › “Pagar R$ X via Pix”
  → POST /api/c/:slug/admin/wallet/topup { amount_cents }
     → cria topup_orders (status=pending, code=TOPUP…, X-Idempotency-Key = UUID por request)
     → POST https://api.mercadopago.com/v1/payments
        body: payment_method_id:"pix", transaction_amount (reais), description,
              external_reference = <code da recarga> (âncora de reconciliação),
              notification_url = https://SEU-DOMINIO/api/webhooks/mercadopago
     → devolve { code, qr_code_text (copia-e-cola), qr_code_base64, expires_at }

Dono paga no app do banco (ou clica “simular” onde permitido)
  → MP chama POST /api/webhooks/mercadopago  { action: "payment.updated", data: { id } }
     1. valida x-signature (HMAC-SHA256 do manifest `id:<data.id>;request-id:<x-request-id>;ts:<ts>;`
        com o secret do painel de APIs do MP) — inválida ⇒ 401, nada muda
     2. responde 200 imediatamente (processa depois; o re-consulta é a fonte da verdade, não o corpo)
     3. GET https://api.mercadopago.com/v1/payments/<id> com o access_token
     4. status=approved && (live_mode bate com o ambiente) e external_reference casa com um topup pending
        → confirmTopupFromProvider()
  → confirmTopupFromProvider (fonte única; chamada por webhook, pelo polling do painel e pelo
    “verificar agora”) — **idempotente por `topup_orders.idempotency` de crédito**: marca paid +
    credited_at e insere o lançamento `topup` no livro-razão exatamente 1× (chave `topup:<code>`).

Polling do modal (`GET /wallet/topup/:code`) re-consulta o gateway também → funciona mesmo se o
webhook se perder; expiração (30 min, `expires_at`) libera o QR vencido para nova tentativa.
```

## 2. Contabilidade

- `wallet_transactions` é **append-only** (tipo `topup | reserve | capture | release | refund | admin_adjust`),
  com `balance_after`/`reserved_after` — o saldo da carteira deriva das linhas; `manualAdjustment` e estornos
  da suíte exigem **justificativa** e caem no `audit_log` (escopo `platform`).
- Reservas: agendar um serviço com mensagens pendentes **empenha** (`reserve`) o preço dos jobs; envio aceito
  ⇒ `capture` (debite efetivo); falha definitiva ⇒ `release`. `allow_negative=false` por padrão — sem saldo,
  a barbearia é notificada e novos envios ficam barrados (agendamento segue funcionando).
- Gasto mensal e “float” (saldo total dos tenants) aparecem na suíte › Visão geral.

## 3. Produção — o que falta ligar (honesto)

1. **App de pagamento do Mercado Pago em produção** (credentials de produção; `live_mode` true) —
   `MERCADOPAGO_ACCESS_TOKEN` (secret) no `wrangler secret put`.
2. `MERCADOPAGO_WEBHOOK_SECRET` (o “secret” da sincronização de webhook do painel de APIs) para validar
   `x-signature`.
3. **HTTPS público** — configure o webhook `https://SEU-DOMINIO/api/webhooks/mercadopago`, tópicos
   `payment.created` + `payment.updated` (o painel antigo chamava isso de IPN; hoje é webhook puro).
4. Política de reembolso/estorno de créditos: por contrato com o dono (a UI já explica que crédito vira
   custo de mensagem e não é dinheiro em caixa para saque).

Sem (1)–(3) o ambiente funciona em `mock`/manual (a suíte pode creditar recarga com justificativa após
conferir o comprovante no painel do MP — endpoint `POST /api/super/topups/:id/confirm`, idempotente).

## 4. Segurança

- `amount_cents` validado (100 … 10.000.000¢ = R$ 1…R$ 100 mil) e faixa por config da plataforma
  (`topup_min_cents/topup_max_cents`).
- Nunca confie no payload do webhook: status final vem do `GET /v1/payments/<id>`.
- `X-Idempotency-Key` no create evita Pix duplicado se o dono clicar duas vezes.
- QR/texto do Pix vivem só no pedido correspondente; `external_reference` é o código `TOPUP…` (sem PII).
