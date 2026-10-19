# Tigu — plataforma SaaS multiempresa para barbearias

Site de agendamento + painel da barbearia + painel do profissional + suíte do operador (Tigu),
com **loja de produtos, carteira de créditos para WhatsApp e lembretes automáticos**.
Stack: **React 18 + Vite + Tailwind** (front), **Hono** no **Cloudflare Workers**, **D1** (SQLite) e **R2** — pt-BR, BRL, fusos do Brasil por tenant.

```
/                     landing da plataforma (marketing)
/comecar              onboarding self-service (cria barbearia + dono)
/login · /recuperar   autenticação única para todas as barbearias do usuário
/c/:slug              site da barbearia (catálogo, agendamento, loja, meus agendamentos)
/c/:slug/admin        painel do dono/gerente (agenda, equipe, serviços, loja, pedidos,
                      clientes/LGPD, mensagens WhatsApp, carteira, configurações, demo, auditoria)
/c/:slug/painel       painel do profissional (agenda própria, status, folgas/bloqueios)
/superadmin           suíte Tigu: empresas, usuários, carteiras, recargas/refunds,
                      precificação, fila global, auditoria platform, config. da plataforma
```

## Por que “multiempresa de verdade”

- **Isolamento no servidor**: cada request `/api/c/:slug/*` resolve a empresa pelo slug (apenas ativas)
  e injeta o `company_id`; repositórios filtram por ele. Trocar o ID no front não revela dados de outra barbearia (testado em `tests/`).
- **RBAC real**: papel por empresa (`owner | manager | barber`) + `platform_role` (`superadmin`).
  Gates no front são UX; a autorização é sempre verificada no Worker.
- **Dinheiro idempotente**: créditos moram no D1 com livro-razão (`wallet_transactions`); Pix aprovado
  (webhook + re-consulta) é a única forma de creditar; cobrança de mensagem só com envio aceito pelo
  provedor, reserva liberada em falha definitiva, estorno pós-entrega creditado automaticamente.
- **Agenda sem overbooking**: slots com trava real (mesmo barbeiro/minuto nunca duas reservas ativas),
  remarcação incrementa `schedule_version` e invalida lembretes antigos, bloqueios de feriado/folga respeitados em todas as visões.

## Rodando em 4 comandos

Requer Node.js 22.12 ou superior. O CI utiliza Node 22.

```bash
npm install
npm run db:reset:local          # D1 local zerado + migrations (ou: npx wrangler d1 migrations apply tigu-db --local)
npm run setup:super -- --email super@tigu.app   # cria o superadmin (mostra a senha UMA vez)
npm run dev                     # API (wrangler :8787) + web (vite :5173)
# em outro terminal:
npm run db:seed:local           # sobe a barbearia demo /c/estilo-premium (usa a senha acima via env)
```

`db:seed:local` deixa tudo pronto:

| Onde | URL | Login |
|---|---|---|
| Site demo | `http://localhost:5173/c/estilo-premium` | — |
| Painel da barbearia | `http://localhost:5173/c/estilo-premium/admin` | `dono@estilopremium.test` / `Demo!Tigu2026` |
| Suíte Tigu | `http://localhost:5173/superadmin` | `super@tigu.app` / (a senha gerada) |

Modos de demonstração ficam ligados pelo `.dev.vars` (copie de `.dev.vars.example`):
`WHATSAPP_MOCK=1` ativa o “modo simulação” de mensagens (fila vista, custo zero, nada é enviado de verdade);
`PAYMENTS_MOCK=1` permite o botão **Simular pagamento aprovado** na carteira.

Para testes de fumaça contra um ambiente de pé: `npm run smoke` (fluxo público+tenant) e
`node scripts/smoke-money.mjs` (Pix→créditos→WhatsApp mock→painel do profissional). Ambos idempotentes e
usam dias separados para não colidir entre si.

## Validação antes do envio

Execute `npm run validate` localmente antes de enviar código à branch de desenvolvimento. O Actions é somente manual; push e Pull Request não iniciam execuções. Consulte [a política de validação e custos](docs/VALIDACAO_LOCAL_E_CUSTOS.md), incluindo a dependência da branch padrão para habilitar o botão manual.

## Scripts úteis

| Script | Faz |
|---|---|
| `npm run dev` | API + web com proxy (`vite` → `/api` → :8787) |
| `npm run build` / `check:types` | build de produção / typecheck completo (app+api+node) |
| `npm test` | vitest no runtime real do Workers (`tests/booking-rules.test.ts`) |
| `npm run db:migrate:local/remote` | aplica migrations no D1 local/produção |
| `npm run setup:super` | cria/redefine superadmin (use com parcimônia em produção) |
| `npm run smoke` | verificação FUM-DE-01 ponta a ponta (exige ambiente rodando) |
| `npm run deploy` | `tsc -b && vite build && wrangler deploy` (docs/DEPLOY.md) |

## WhatsApp & Pix — o estado honesto

- O **envio real** usa a **API oficial do WhatsApp Business (Cloud API)** por empresa (Phone Number ID +
  token de System User criptografado no D1). Sem credenciais, tudo roda em **simulação/mirror** e o link
  `wa.me` segue disponível para confirmação manual — nada é mostrado como “enviado de verdade” se não foi.
- **Embedded Signup** (conectar sem abrir painel da Meta) está implementado de ponta a ponta no backend e
  no painel, e só aparece quando `WHATSAPP_APP_ID/APP_SECRET/CONFIG_ID` existem — exige **partner config**
  aprovado na Meta (uma etapa de negócio, não de código). Ver `docs/WHATSAPP.md` (inclui a conversa sobre
  **coexistência** com o app Business e a janela de 24h).
- **Pix** via **Mercado Pago** (create payment + webhook com `x-signature` + re-consulta como fonte da
  verdade). Em produção, o gateway **precisa** de um HTTPS público alcançável e do access token de produção. Ver `docs/PAGAMENTOS.md`.

## Documentação

- `docs/API.md` — referência da API (tenant + super + auth)
- `docs/DEPLOY.md` — produção na Cloudflare (recursos, secrets, cron, checklist)
- `docs/WHATSAPP.md` — provedor Meta: conexão, webhook, templates, cobrança, embedded signup, limites
- `docs/PAGAMENTOS.md` — Pix (Mercado Pago): recargas, webhooks, idempotência, estornos, segurança
- `docs/PRODUCAO.md` — rotina operacional do dia a dia

## Estrutura

```
api/            Hono no Worker
  lib/          auth/sessão, crypto (PBKDF2+AES-GCM), tenant, settings, booking (trava),
                availability (grade), wallet (livro-razão), topup (Pix), messaging/ (provider,
                jobs, cron, webhooks), demo-seed, audit, notify, time
  routes/       auth · public · admin (tenant) · barber · super · webhooks · uploads
src/            SPA React (rotas por empresa; base da API derivada da URL → mesmo build serve N tenants)
migrations/     D1 (0001_init.sql — 70 statements, idempotentes)
tests/          @cloudflare/vitest-plugin (regras críticas no runtime real)
scripts/        create-super · setup-demo · smoke · smoke-money · reset-local-db
```

## Licença & dados

Uso comercial da Tigu exige: política de privacidade própria por barbearia (o consentimento LGPD é
registrado na reserva), e o custo de conversas do WhatsApp é da barbearia (via créditos). Todos os dados
de demonstração do repositório são fictícios e apagáveis (botão no painel › Demonstração).
