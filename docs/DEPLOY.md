# Deploy na Cloudflare (produção)

Tempo estimado: ~15 min. Custo inicial: plano **Workers Free** dá conta de uma barbearia (D1 incluso no plano, R2 com franquia grátis).

## 0. Pré-requisitos

- Node 20+
- Conta Cloudflare (grátis) e `npm i -g wrangler` (ou use `npx wrangler` como está no repo)
- `git` (recomendado para o CI)

## 0.1. Específico da Tigu (multiempresa)

- Uma instância da plataforma serve N barbearias. Recursos: **1 D1** (`tigu-db`) + **1 R2** (`tigu-media`) por ambiente.
- Primeiro deploy: aplicar migrations, criar o superadmin e opcionalmente semear a demo:
  ```bash
  npx wrangler d1 migrations apply tigu-db --remote
  npx tsx scripts/create-super.mjs --remote --email super@SEU-DOMINIO   # senha exibida 1×
  # demo comercial (opcional): com o Worker no ar e o super logado, pela suíte ou:
  # TIGU_SUPER_PASSWORD=… node scripts/setup-demo.mjs  (aponta API_URL p/ produção se quiser)
  ```
- `cron` (`*/1 * * * *`) roda a fila de mensagens de todas as empresas — sem ele, nada é enviado no horário.
- Webhooks externos (obrigatórios p/ envio real e Pix): `/api/webhooks/evolution/` e `/api/webhooks/mercadopago`.
- Secrets: `wrangler secret put SESSION_SECRET|MSG_ENC_KEY|MERCADOPAGO_ACCESS_TOKEN|MERCADOPAGO_WEBHOOK_SECRET|EVOLUTION_WEBHOOK_SECRET` (docs/WHATSAPP.md, docs/PAGAMENTOS.md).

## 1. Autenticação e criação dos recursos

```bash
npx wrangler login

# Banco D1 (1 por ambiente — recomendado criar também tigu-db-staging)
npx wrangler d1 create tigu-db
```

Copie o `database_id` impresso e substitua no **`wrangler.jsonc`**:

```jsonc
"d1_databases": [{ "binding": "DB", "database_name": "tigu-db", "database_id": "COLE-AQUI" }]
```

Bucket para upload de imagens (logo, capa, fotos de serviços/produtos):

```bash
npx wrangler r2 bucket create tigu-media
```

Se não usar bucket com esse nome, ajuste o binding `MEDIA` no `wrangler.jsonc`. Sem R2 o sistema segue operando: uploads ficam restritos e o painel avisa.

## 2. Segredos

```bash
npx wrangler secret put SESSION_SECRET      # openssl rand -hex 32
# Opcionais (links de WhatsApp já funcionam sem eles — servem para o envio ativo futuro):
# npx wrangler secret put EVOLUTION_API_KEY
# npx wrangler secret put EVOLUTION_WEBHOOK_SECRET
```

Em dev local, use um arquivo **`.dev.vars`** no diretório raiz (já no `.gitignore`):

```
SESSION_SECRET="troque-isto-em-prod"
```

## 3. Migrations + primeiro deploy

```bash
npm ci
npm run db:migrate:remote        # aplica migrations/0001 e 0002 no D1 de produção
npm run deploy                   # build (tsc + vite) e wrangler deploy (Assets + Worker)
```

O site já está no ar na URL `*.workers.dev` (ou conecte um domínio em *Workers → Custom domains*).

## 4. Onboarding seguro (sem credencial padrão)

1. Acesse `https://SUA-APP/admin` — como não existe usuário, o sistema cai no **setup**:
   - defina nome/e-mail/senha do proprietário (≥ 10 caracteres);
   - marque **“popular com dados de demonstração”** se quiser homologar com agenda cheia — ou deixe desmarcado para começar limpo.
2. Alternativa via CLI: `npm run setup:admin -- --remote --email dono@barbearia.com --name "Dono" --password 'SenhaForte123'`

## 5. (Opcional) Dados de demonstração depois

```bash
npm run db:seed:remote   # idempotente; ATENÇÃO: renova as senhas dos barbeiros demo e as imprime
```

Para remover tudo que é fictício: painel → **Demonstração → Remover dados de demonstração** (preserva histórico real).

## 6. CI/CD com GitHub Actions

O repo já traz `.github/workflows/ci.yml` (typecheck + testes + build em PR; deploy no push da `main`). Configure no repositório:

- Secret `CLOUDFLARE_API_TOKEN` — token com permissão *Edit* em Workers, D1 e R2;
- Variable `CLOUDFLARE_ACCOUNT_ID` — aparece no rodapé do painel da Cloudflare.

## 7. Domínio próprio

Cloudflare dashboard → Workers & Pages → seu Worker → **Settings → Domains & Routes → Add custom domain**. DNS gerenciado pela Cloudflare resolve em minutos; o certificado é automático.

## Rollback

Cada deploy fica versionado: `npx wrangler deployments list` → `npx wrangler rollback <deployment-id>`. As migrations são aditivas (nunca destrutivas), então o rollback do código não perde dados. Se aplicar a v-next com migrations, rode `npm run db:migrate:remote` **antes** do deploy.

## Checklist de go-live

- [ ] `SESSION_SECRET` gerado fora do repo e trocado a cada incidente
- [ ] `database_id`/`MEDIA` apontando para recursos seus
- [ ] Onboarding feito **sem** dados demo (ou demo removida após homologação)
- [ ] Expediente dos barbeiros + feriados municipais conferidos no painel
- [ ] Política de cancelamento revisada (Configurações → Regras)
- [ ] Teste real: agendar → aparecer no sino do admin → concluir no painel do barbeiro
- [ ] Backup automático: `d1 export` agendado (ver PRODUCAO.md)
