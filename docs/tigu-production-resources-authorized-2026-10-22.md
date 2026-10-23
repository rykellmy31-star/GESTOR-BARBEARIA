# TIGU — provisionamento autorizado de recursos de produção, isolados

O titular autorizou explicitamente a criação dos recursos de produção do TIGU e aceitou que o uso da Cloudflare possa gerar cobranças, em diálogo atual: "E sim, eu autorizo a criação de todas as coisas [...]" e "Manda ver".

## Gatilho específico do GitHub Actions
`TIGU_CREATE_PRODUCTION_RESOURCES_ONCE`

Ação exata: executar script guardado `scripts/production-create-resources-once.mjs` **após CI íntegro** e somente em push da branch `audit/tigu-primeira-validacao`.

Escopo **deste passo**:
- Verificar por GET a existência e saúde de `tigu-staging`, `tigu-staging-db`, `tigu-staging-media` e o domínio que ainda deve estar no staging;
- Exigir que os recursos de produção `tigu-production-db` e `tigu-production-media` estejam AUSENTES antes de qualquer criação;
- POST apenas para criar **um novo D1 vazio** chamado `tigu-production-db` e **um novo bucket R2 vazio** chamado `tigu-production-media`;
- Não copiar qualquer dado pessoal, nem usar migrações, nem instalar segredos, nem criar o Worker, nem alterar DNS ou pagamentos/WhatsApp.

A configuração para futuro `tigu-production` já existe em `wrangler.production.template.jsonc`; propositalmente possui UUID inválido e nenhum cron, impedindo publicação insegura.

A operação **não é idempotente quanto à criação**: se houver falha parcial, o script recusa repetição automática assim que detectar recursos existentes. Necessária inspeção de estado antes de continuar.

O fluxo de comercialização foi adicionado à página como botão "Adquirir plano", com acesso à nova página `/adquirir`, mas pagamento Pix permanece explicitamente indisponível até a implementação de backend de pedidos pendentes, webhook validado e cadastro condicionado à confirmação. Não apresentar como checkout homologado.

Nenhum custo fixo é garantido: o consumo dos recursos pode ser faturável pela Cloudflare e depende do plano da conta.
