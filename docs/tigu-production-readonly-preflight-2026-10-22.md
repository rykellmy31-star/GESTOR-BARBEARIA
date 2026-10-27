# TIGU — preparação da produção isolada (2026-10-22)

O titular confirmou que sua Cloudflare tem somente o Worker `tigu-staging`, e autorizou a **preparação segura** da produção mantendo intactos os recursos existentes.

## Modelo de produção criado no repositório

- Worker reservado: `tigu-production`.
- D1 reservado: `tigu-production-db`, diferente de `tigu-staging-db` e do nome legado `tigu-db` presente no `wrangler.jsonc`.
- R2 reservado: `tigu-production-media`, diferente do R2 de homologação.
- Configuração: `wrangler.production.template.jsonc`; ID do banco é placeholder literal para impedir deploy acidental.
- `APP_ENV=production`, `TIGU_STAGING=0`, `PAYMENTS_MOCK=0`, `WHATSAPP_MOCK=0`, `MERCHANT_PIX_ENABLED=0`, cron inicialmente vazio.
- Sem rotas/domínios configurados, sem `PUBLIC_URL`, sem credenciais de pagamento ou Meta, sem migração/importação de contas.
- Fluxos reais de cobrança/mensagens continuam **inativos** até contas Meta e Mercado Pago configuradas, WEBHOOKs verificados, autorização de empresários e consentimento de clientes.

## Gatilho exato deste commit

**`TIGU_PRODUCTION_READONLY_PREFLIGHT_ONCE`**

Apenas inspecionar por **GET** inventário de D1, R2 e Workers via o token existente de staging e `/api/health` dos dois domínios já existentes. Exigir staging íntegro e nomes de produção livres. Falhar se algum recurso de produção já existir, para que não haja sobrescrita.

**Não autoriza** criar recursos novos, implantar Worker, conectar DNS, alterar qualquer binding, definir secrets, copiar banco com cadastros reais, habilitar PIX, mensagem Meta nem executar cron. As operações de provisionamento remoto poderão ter consumo faturável e exigirão aprovação explícita sobre esses custos antes de serem executadas. Qualquer publicação real requer revisão e uma autorização separada.

O banco atual do staging contém dados e contas do usuário; a futura produção terá banco distinto e inicialmente vazio. Antes de mudar o domínio, definir migração segura, backup, verificação de integridade e aceite do usuário. Nenhuma conta/cliente deve perder acesso.

## Validação anterior

GitHub Actions de confirmação de código: `39878946232`, sucesso. Mais de 300 testes de aplicação e a jornada Chromium de homologação aprovados. A verificação remota foi mantida como etapa independente e sem escrita.

## Segunda execução — correção do contrato de homologação

Na primeira execução `39879248151`, os testes locais passaram, mas a etapa `staging-smoke.mjs` recusou `payments.mercadopago=true`. Esse valor é **somente presença do segredo** (MP_ACCESS_TOKEN, definido pelo titular), não significa Pix habilitado. Código existente em `api/lib/payments.ts` e `api/routes/webhooks.ts` impede transação/webhook real quando `TIGU_STAGING=1`. O mesmo vale para o provedor Meta.

Corrigidos `staging-smoke.mjs` e `staging-update-ci.mjs` para aceitarem presença/ausência de credenciais **enquanto comprovam staging:true, mock Pix:false, mock WhatsApp:true e dados e secrets fortes**; adicionados testes de RBAC/provedores para impedir a remoção acidental dos bloqueios.

Repetir o mesmo gatilho **`TIGU_PRODUCTION_READONLY_PREFLIGHT_ONCE`**, sem qualquer criação/deploy/migração/cobrança, para obter a evidência do inventário Cloudflare dos nomes de produção.
