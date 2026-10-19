# Tigu — Homologação funcional isolada (sem clientes reais)

Este documento prepara um **segundo ambiente**: a prévia visual atual em Cloudflare Pages (`/preview`) continua independente. O Worker de homologação poderá abrir telas de login, agenda e gestão com D1 **de testes**, sem conectar Pix ou WhatsApp reais.

**Situação:** arquivos e guardas preparados; nenhuma conta Cloudflare, banco, bucket ou Worker foi criado por esta alteração.

## O que fica isolado

| Recurso | Ambiente de homologação |
| --- | --- |
| Worker | `tigu-staging` (endereço próprio `*.workers.dev`) |
| Banco | `tigu-staging-db` (D1 próprio) |
| Imagens | `tigu-staging-media` (R2 próprio) |
| APP_ENV | `production` para proteção das sessões e recuperação de senha |
| TIGU_STAGING | `1` (bloqueio adicional de Meta/Pix real) |
| WhatsApp | só conexão mock/demonstração |
| Pix | recarga desabilitada — **não transferir dinheiro** |
| Cron | desabilitado, sem disparos automáticos |
| Secrets | exclusivos do ambiente, nunca salvos no GitHub |

A flag `TIGU_STAGING=1` força bloqueios no provedor Meta, no Mercado Pago, nas rotas de conexão Meta e nos webhooks públicos, além de desabilitar o cron. Ela **não é um mecanismo de autenticação nem substitui** a proteção dos dados de testes.

## Passos quando quisermos ativar o Worker

Requisitos: Node.js 22+, uma conta Cloudflare autenticada pelo Wrangler e acesso ao repositório privado da branch `audit/tigu-primeira-validacao`. Os comandos abaixo são para um terminal na **raiz desse projeto**.

1. Crie um banco de **homologação**, não o `tigu-db` do produto:

   ```bash
   npx wrangler login
   npx wrangler d1 create tigu-staging-db
   ```

   Copie o `database_id` impresso pela Cloudflare.

2. Crie um bucket R2 separado para fotos fictícias:

   ```bash
   npx wrangler r2 bucket create tigu-staging-media
   ```

3. Gere a configuração local segura (não vai para o Git):

   ```bash
   npm run staging:prepare -- --database-id SEU_UUID_DO_D1_STAGING
   npm run staging:validate
   ```

   `scripts/staging.mjs` **recusa deploy** se o banco, Worker, bucket, variáveis e cron não forem compatíveis. Ele também compara o ID do D1 com o da configuração principal, impedindo que ambos apontem deliberadamente para o mesmo recurso.

4. Configure dois segredos **exclusivos da homologação**, com valores aleatórios distintos daqueles usados em qualquer outro projeto:

   ```bash
   npx wrangler secret put SESSION_SECRET --config wrangler.staging.jsonc
   npx wrangler secret put MSG_ENC_KEY --config wrangler.staging.jsonc
   ```

   Nunca divulgue esses valores ou os comite; gere e guarde-os fora do Git. Na primeira publicação do Worker o Wrangler pode pedir a criação do próprio Worker antes de aceitar secrets. Se isso ocorrer, configure os secrets imediatamente após o primeiro deploy e **não utilize o login até estarem definidos**.

5. Aplique migrações **somente no D1 de homologação**, em seguida publique:

   ```bash
   npm ci
   npm run staging:migrate
   npm run staging:deploy
   ```

6. Com o banco de testes preparado, crie o superadministrador de homologação (a senha será gerada localmente se não for informada):

   ```bash
   npm run staging:super -- --email admin-staging@exemplo.test
   ```

   Guarde a senha de teste em gerenciador apropriado. Evite usar e-mail, telefone ou senhas de clientes reais. Após publicar, acesse `https://tigu-staging.SUA_SUBCONTA.workers.dev/superadmin` e `/api/health`; a resposta do health deve conter `"staging":true`, `"d1":true` e `"r2":true`.

### Restrições importantes

- Os scripts `staging:migrate`, `staging:deploy` e `staging:super` só passam pela validação da configuração separada. Não utilize comandos sem o `--config` para agir sobre o banco de teste.
- O banco inicial é vazio até criar o superadmin e empresas fictícias. Não haverá migração automática de registros do CR Jornada, da `main` ou do ambiente comercial.
- **Não ative Webhooks, tokens Meta ou Mercado Pago** no Worker de homologação. As interfaces podem mostrar funções não operacionais de Pix e WhatsApp, por opção de segurança.
- O modo mock de WhatsApp é apenas uma resposta simulada; o cron está desligado para não agendar disparos sozinho.
- O registro público de contas merece proteção por acesso restrito antes de divulgar a URL. Não compartilhe o Worker de homologação com clientes. Cloudflare Access pode ser adicionado quando a conta oferecer o recurso.
- A prévia visual Pages permanece em `https://tigu-preview.pages.dev/preview` **se a publicação Pages já estiver concluída**; não confundir esse endereço com o Worker de homologação.

## Próximos trabalhos pendentes

- Fazer a implantação assistida com IDs de recursos **sem compartilhar senhas ou tokens neste chat**.
- Testar autenticação real no D1 de testes, permissões e criação de empresa fictícia no Worker publicado.
- Aplicar controles adicionais contra abuso público (limites persistentes/Turnstile/Cloudflare Access).
- Validar integrações reais em ambiente específico e controlado **somente com autorização posterior**.
