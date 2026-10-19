# Prévia visual Tigu (Cloudflare Pages)

Esta etapa serve **somente para inspecionar a interface**. Não é o ambiente comercial e não substitui Worker + D1 + R2.

## Como publicar com GitHub

No Cloudflare Dashboard → Workers & Pages → criar Pages → conectar o repositório privado `rykellmy31-star/GESTOR-BARBEARIA`.

- Nome sugerido: `tigu-preview`.
- Branch selecionada: `audit/tigu-primeira-validacao`.
- Framework: React / Vite.
- Comando de build: `npm run build`.
- Saída estática: `dist`.
- Diretório raiz: raiz do repositório.
- Node.js: versão 22 (por exemplo `NODE_VERSION=22` na configuração de build).

Acompanhe os deploys no painel do Cloudflare Pages. Após uma implantação bem-sucedida, se o nome estiver disponível, a URL será `https://tigu-preview.pages.dev`; navegue para `/preview`.

## Rotas sem backend

- `/`: página de apresentação do Tigu.
- `/preview`: painéis simulados com navegação por Superadmin, Barbearia, Agenda, WhatsApp, Carteira e Loja. **Os dados são fictícios e permanecem apenas na interface.**

As páginas reais de `/login`, `/superadmin`, `/comecar` e `/c/:slug/*` **não operam inteiramente** em Pages estático, porque fazem chamadas a `/api/*`.

Não é necessário criar usuários, informar cartão, ligar WhatsApp ou habilitar Pix para examinar `/preview`. Esta rota não usa API, banco ou tokens.

## Próximo passo: homologação funcional

Quando desejarmos testar cadastros, logins, agendamentos e relatórios, precisaremos de **outro ambiente Cloudflare Worker de homologação**, com banco D1 e bucket R2 de teste separados e secrets exclusivos. A implantação do Worker usa `wrangler deploy` após build, não a opção de publicar somente o diretório `dist`.

Nunca apontar homologação para recursos do CR Jornada. Não adicionar segredos ao repositório.

## Controle de mudanças

Todas as alterações em revisão continuam na branch `audit/tigu-primeira-validacao`, sem merge automático para `main`. Não foi criado um deploy automático de Worker comercial.
