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
