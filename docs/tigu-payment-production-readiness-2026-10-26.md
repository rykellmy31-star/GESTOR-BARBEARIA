# TIGU: diagnóstico seguro do Pix real (26/10/2026)

Esta nota registra somente **preparação**, sem ativar pagamento ou alterar Cloudflare.

- O código Marketplace do TIGU usa OAuth do profissional, endpoint de cobrança Pix e webhook assinado.
- No teste HTTP público de 26/10/2026, `agendamentos.crjornada.com/api/health` indica `staging:true`; esse domínio ainda não é produção.
- `wrangler.production.template.jsonc` tem `MERCHANT_PIX_ENABLED=0`, intencionalmente.
- Produção ainda exige Worker separado `tigu-production`, migrações D1, credenciais independentes e callback OAuth correspondente ao domínio de produção. Não trocar o domínio staging sem plano de migração.
- Um workflow isolado consulta somente metadados de Worker, D1, R2 e presença/nome de segredos, sem copiar credenciais, sem SQL e sem PUT/POST/DELETE.
- **O primeiro Pix real só deve ser cobrado após:** testar checkout com a conta vinculada do profissional, conferir `collector_id`, URL do webhook, assinatura, idempotência e retorno do status, com valor baixo e confirmação do titular.
