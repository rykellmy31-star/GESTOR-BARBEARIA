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


## Atualização da prévia: autoria do desenvolvimento

O rodapé compartilhado exibe **Sistema desenvolvido por Carlos Rykellmy Santos Correia** em todas as rotas React, incluindo a página inicial, `/preview`, o site de cada barbearia, telas de login e painéis internos. O texto é discreto, legível no celular e colocado após o conteúdo; nenhum formulário ou reserva é afetado.

O menu da suíte `/superadmin` também foi alinhado com as rotas reais (`overview`, `companies`, `users`, `wallets`, `topups`, `pricing`, `messages`, `audit`, `settings`). Esta correção não muda o menu da prévia estática, que já é independente e funcional sem backend.

O GitHub Actions confere que o build `dist/assets` contém o crédito de autoria. Isso valida os artefatos gerados pelo GitHub, não confirma por si só que o Pages terminou de publicá-los.


## Agenda responsiva e navegação direta

A prévia estática foi aprimorada para acompanhamento pelo celular:

- Em telas pequenas, agendamentos aparecem em **cartões**, com cliente, horário, serviço, barbeiro e situação, sem rolagem horizontal.
- Na seção **Agenda**, é possível filtrar os registros fictícios por barbeiro usando botões acessíveis.
- A tela selecionada fica registrada em `?tela=`, permitindo abrir links diretos e manter a seleção depois de atualizar o navegador.

Links de demonstração:

- Superadmin fictício: `/preview`
- Agenda: `/preview?tela=agenda`
- WhatsApp: `/preview?tela=mensagens`
- Carteira de créditos: `/preview?tela=carteira`
- Loja: `/preview?tela=loja`

Se a API funcional não responder, a visão geral do Superadmin real mostra uma explicação e um botão **Tentar novamente**, em vez de deixar a tela em branco.

Os dados da `/preview` continuam exclusivamente fictícios. O GitHub Actions verifica o build, os testes e a presença dos elementos principais da agenda no bundle. A publicação efetiva depende da implantação do Cloudflare Pages.


## Página de vendas com contato comercial configurável

- No **Superadmin → Config. plataforma → Contato da página de vendas**, o responsável pode informar WhatsApp com DDI+DDD, e-mail opcional, título comercial e mensagem inicial para o WhatsApp.
- O toggle **Exibir contato comercial** habilita/desabilita a publicação. O contato é guardado no D1 existente (tabela `platform_settings`), sem gravar o número no código ou exigir migração nova.
- A API protegida `GET/PUT /api/super/marketing/contact` exige sessão de superadministrador. Mudanças são auditadas.
- O endpoint público `GET /api/marketing/contact` retorna somente o contato marcado como publicado. Se estiver desligado, número e e-mail ficam ocultos.
- Na página inicial de contratação, a seção surge abaixo dos planos quando o contato está publicado; WhatsApp usa `https://wa.me/` e mensagem codificada, e o e-mail usa `mailto:`.
- A prévia **estática**, disponível em `/preview?tela=vendas`, mostra apenas o visual do atendimento, com botões desativados e **sem contato falso**.
- **Importante:** a prévia de Cloudflare Pages sozinha não possui backend D1. Editar pelo superadministrador e propagar alterações à página comercial requer publicar o Tigu como Worker + D1 ou conectar um backend de homologação/produção de forma segura. Não alegar atualização dinâmica de contatos no Pages estático sem essa integração.
- Testes automatizados verificam autenticação, isolamento do Superadmin, validação, publicação, persistência, ocultação e auditoria.



## Planos de contratação editáveis

- No Superadmin, em **Config. plataforma → Planos e valores da página de vendas**, é possível editar preços em centavos, número máximo de profissionais, limite mensal de mensagens e a disponibilidade de WhatsApp e loja.
- A API pública `GET /api/marketing/plans` consulta a tabela `plans` no D1; somente o Superadmin pode alterar registros via `PUT /api/super/plans/:code`. Cada alteração é auditada.
- O plano `free` continua com mensalidade zero. Limites alterados na tabela `plans` podem afetar assinaturas existentes imediatamente; revisar impactos antes de salvar.
- No Cloudflare Pages **sem backend**, a página inicial identifica os três preços de referência como **ilustrativos**. A prévia `/preview?tela=vendas` mostra cartões de exemplo, sem compra habilitada.
- Atualizar preços **não implementa cobrança de assinaturas**: os planos pagos dependem de confirmação/ativação assistida e integração de pagamento recorrente.
- Testes cobrem consulta pública, autorização do Superadmin, edição, rejeição de alterações inválidas e atualização dos valores devolvidos pela API.


## Contatos interessados em contratar (nova etapa)

- Os botões dos planos **Pro** e **Scale** na página de vendas abrem `/contratar?plano=pro` ou `?plano=scale`.
- O formulário pede nome, nome da barbearia, e-mail, telefone, dúvidas opcionais e **consentimento explícito** para contato comercial. Ele **não** cobra, cria assinatura ou muda o plano de uma empresa.
- Os dados só podem ser enviados quando o Worker está acessível. No Cloudflare Pages estático, o envio fica indisponível e a tela explica a limitação. **Não compartilhar dados reais na demonstração.**
- O backend usa `POST /api/marketing/leads` com validação, proteção por origem, honeypot, limite persistente de até cinco tentativas/hora por impressão digital (hash) e unicidade por e-mail/plano/janela de 30 minutos. É necessário configurar antibot adicional antes de operação comercial pública.
- A migração `migrations/0003_sales_leads.sql` cria as tabelas `sales_leads` e `sales_lead_rate_limits`; **deve ser aplicada ao D1 de homologação antes de testar o fluxo funcional** (`npm run staging:migrate`).
- No Superadmin há a rota `/superadmin/leads` **Interessados**: somente superadministradores podem consultar nome e contato, pesquisar por barbearia/e-mail e mudar o status de Novo → Contato realizado → Em negociação → Encerrado, deixando nota interna. Status comerciais **não significam pagamento confirmado**.
- A prévia visual ganhou `/preview?tela=interessados`, com nomes inventados e nenhuma informação de clientes reais.
- Contatos não geram notificações externas automaticamente. O atendimento é manual enquanto não houver integração e conformidade para notificações.


## Verificação antirobôs na contratação

A rota `/contratar` usa o componente Cloudflare Turnstile **somente quando um Worker de produção/homologação está configurado**. A site key chega por `GET /api/marketing/lead-config`; a chave secreta nunca sai do Worker. O servidor verifica cada token em `siteverify` **antes** de registrar o contato.

- Na prévia estática Pages, não existe Worker/D1: o formulário continua desativado e informa que não recebe dados pessoais.
- No Worker de homologação sem `SALES_TURNSTILE_SITE_KEY` e `SALES_TURNSTILE_SECRET`, o formulário é bloqueado com mensagem explícita.
- Depois de configurar as chaves e testar a validação, a solicitação poderá ser enviada com autorização do interessado e verificada na lista do Superadmin.
- A prévia `/preview?tela=vendas` e `/preview?tela=interessados` continua usando apenas dados ilustrativos e não possui desafio antirobôs nem faz requisições financeiras.
- Esta proteção do **funil comercial** não resolve sozinha as proteções de autenticação/cadastro do restante da plataforma nem a política de retenção LGPD.


## Gestão e retenção de interessados (nova atualização)

A demonstração estática `/preview?tela=interessados` agora mostra uma seção visual de privacidade. São **somente dados fictícios**, e os controles mostrados no preview não alteram o banco.

No Superadmin **funcional**, em `/superadmin/leads`, o proprietário pode configurar a retenção dos contatos comerciais para **30, 90, 180 ou 365 dias** (proposta inicial: 180 dias), limpar contatos com prazo vencido em lotes de até 200 e excluir individualmente um contato com motivo e confirmação. Somente o Superadmin pode executar essas ações; eventos de exclusão são auditados sem copiar e-mail, telefone ou mensagem do interessado.

A rota pública `GET /api/marketing/privacy` retorna somente o prazo de retenção e a finalidade, para que o formulário `/contratar` informe esse prazo ao visitante antes da autorização de contato. Caso não exista backend para fornecer esse prazo, o envio permanece bloqueado.

Quando o Worker **de produção** for publicado com o cron habilitado, o trabalho agendado fará a exclusão dos contatos vencidos às **03:05 UTC**, em lotes limitados. A homologação continua sem cron; nela, a limpeza é somente manual pelo Superadmin. Hashes antigos dos limites de solicitação também são descartados depois de 48 horas.

**Conformidade:** a política inicial de 180 dias é uma escolha técnica, não uma conclusão jurídica. A aprovação da política de privacidade, bases legais, comunicação aos titulares e rotinas LGPD continua pendente antes de coletar dados reais.


## Tigu Start pago após teste de 15 dias

Conforme pedido do proprietário, a página de vendas passou a apresentar o **Tigu Start por R$ 19,99/mês** e uma aba clicável **Teste grátis por 15 dias**. A prévia `/preview?tela=vendas` também usa R$ 19,99 como valor **ilustrativo**, não R$ 0,00.

O CTA do Start leva ao cadastro `/comecar`, agora com a oferta de teste explícita. O novo cliente **não informa cartão, não recebe cobrança automática e inicia uma assinatura `trial`** com `period_end` definido no D1 exatamente 15 dias após `started_at`.

Após o fim do teste, o backend bloqueia **novas reservas, novos pedidos públicos e alterações nos painéis da empresa**, retornando HTTP 402; a consulta de dados e os cancelamentos públicos existentes permanecem disponíveis. A ativação de uma assinatura paga ainda é manual pelo Superadmin, pois a integração de cobrança recorrente permanece pendente. Isso não implica débito automático de R$ 19,99.

A migração `0004_start_trial.sql` altera o Start de R$ 0,00 para R$ 19,99 somente quando ele ainda está com preço zero, preservando preço já editado pelo Superadmin. Assinaturas `trial` legadas sem prazo recebem 15 dias de tolerância **a partir da aplicação da migração**, evitando bloqueio retroativo imediato. Contas `active` não são automaticamente alteradas nem cobradas.

O Superadmin, em Config. plataforma, pode agora **editar o preço do Start**, que deve permanecer maior que zero. O painel da barbearia funcional mostra o prazo restante e a mensalidade. O Pages estático, sem Worker/D1, demonstra apenas o visual e não registra testes reais.

**Deploy pendente:** aplicar `npm run staging:migrate` no D1 isolado e publicar o Worker de homologação. Não há confirmação de publicação na Cloudflare apenas porque o GitHub Actions aprovou o build.
