# TIGU — painel de prontidão comercial e atualização de homologação

Continuidade até 100% solicitada pelo proprietário em 22/10/2026.

## Evidências da homologação
- Auditoria externa pública: `https://agendamentos.crjornada.com/api/health` confirma serviço `tigu-api`, `staging:true`, D1/R2 e segredos de sessão e criptografia presentes; provedor Mercado Pago real ausente, Meta WhatsApp ainda em mock e Embedded Signup ausente.
- `/api/marketing/plans`: Free, Pro, Scale visíveis; `automatic_billing:false`.
- `/api/marketing/lead-config`: Turnstile obrigatório, mas sem chaves, impedindo receber interessados reais com segurança.
- `/api/marketing/contact`: contato comercial desativado.
- Sem sessão, Super Admin retorna 401, e a página pública não oferece prévia visual.
- Backup D1: execução push `39786387373`, exportação remota read-only restaurada em SQLite efêmero com integridade e foreign keys `ok`; não valida restauração remota.
- Inventário R2: execução push `39789438559`, origem staging 7 objetos, destino de recuperação 1 objeto; inventário completo, restauração integral do acervo **não comprovada**.

## Mudança realizada nesta execução
A página Super Admin → Integrações passa a exibir (somente administradores autenticados) a prontidão D1/R2, segredos fortes, flags Turnstile, contato comercial e se o ambiente está em staging. As credenciais são mantidas exclusivamente na Cloudflare, nunca expostas em API, logs ou página. Testes de controle de acesso e não divulgação de segredo adicionados e concluídos.

## Gatilho de publicação
Executar apenas `TIGU_UPDATE_WORKER_STAGING_ONCE` para atualizar Worker existente `tigu-staging` depois de CI passar. Preservar D1, R2, usuários, dados, secrets e cron. Sem migrações, sem cobranças ou WhatsApp reais. NÃO alterar ambiente de produção.

Esta publicação **não** elimina os bloqueios de credenciais, Turnstile, contato comercial e recuperação completa de R2. O sistema não deve ser anunciado como 100% em produção apenas por passar os testes de staging.
