# TIGU — Conectar Cloudflare por token com GitHub Actions

**Escopo:** somente `rykellmy31-star/GESTOR-BARBEARIA`, branch `audit/tigu-primeira-validacao`. O CR Jornada possui repositório e recursos independentes.

## Preparação pelo proprietário (não enviar tokens no chat)

1. Em **Cloudflare → My Profile → API Tokens → Create Token → Create Custom Token**, crie um token revogável, de preferência com validade limitada, restrito à conta usada pelo TIGU. Para o **primeiro diagnóstico apenas**, selecione as permissões da conta:
   - **D1: Read**
   - **Workers Scripts: Read**
   - **Workers R2 Storage: Read**
   Não marque Write/Edit; não é necessário acesso à Global API Key. Alguns nomes podem variar na interface.
2. No repositório [TIGU — Secrets do Actions](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/settings/secrets/actions), clique em **New repository secret** e cadastre o token com o nome exato `CLOUDFLARE_AUDIT_TOKEN`. Nunca incluir o valor no commit, em arquivos `.env` ou nas mensagens do chat.
3. Copie o **Account ID** (32 caracteres hexadecimais) da página da conta Cloudflare. Em [TIGU — Variables do Actions](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/settings/variables/actions), use **New repository variable** com nome exato `CLOUDFLARE_ACCOUNT_ID`.
4. Depois de cadastrar os dois itens, execute o workflow **Tigu - verificacao de codigo** na branch `audit/tigu-primeira-validacao` pela aba [Actions](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions). Se a opção manual não aparecer para essa branch, um novo commit nessa branch faz o GitHub Actions rodar automaticamente. Informe apenas que a configuração foi feita; nenhum segredo precisa ser revelado.

## O que o GitHub Actions faz automaticamente

Após passar nos testes locais, uma etapa opcional faz quatro operações GET na API Cloudflare:

- Verifica se o token está ativo;
- Verifica permissão de listar **D1**, buscando somente `tigu-staging-db`;
- Verifica permissão de listar **R2**, buscando somente `tigu-staging-media`;
- Verifica permissão de listar **Workers**, procurando `tigu-staging`.

Os logs mostram somente estados e presença/ausência dos recursos pretendidos, nunca tokens, UUIDs do banco, dados de clientes, outros buckets/Workers ou conteúdo do banco. Na branch de auditoria, a etapa é executada após os testes locais e falha explicitamente se não houver token ou Account ID, sem fazer modificações. O ID é lido primeiro de Repository Variables e, se ausente, de Repository Secrets.

O script [scripts/cloudflare-audit.mjs](../scripts/cloudflare-audit.mjs) recusa respostas de erro, token revogado e Account ID inválido. Seus testes locais usam respostas simuladas; portanto **um workflow verde sem a etapa remota executada não confirma acesso à Cloudflare**.

## Depois do diagnóstico: execução dos dois marcos restantes

Com acesso de leitura confirmado, podemos inspecionar quais recursos precisam ser criados e configurar **um segundo token específico de staging**, com as permissões mínimas de escrita realmente necessárias para criar/migrar D1, R2 e publicar Worker de homologação, sem dar permissão a recursos de produção. Esse segundo token deve ser salvo em outro Secret do repositório, nunca enviado pelo chat. Fluxos de criação, publicação e backup requerem autorização de operação e controles separados.

Não conceder escrita à produção para pular a homologação. Backups são completos somente após exportação, inventário de objetos R2, validação dos arquivos e teste de restauração controlada em recursos isolados. A operação real pode gerar custos Cloudflare e depende de consentimento do proprietário.

**Estado:** a automação de diagnóstico está preparada no código; somente a execução remota bem-sucedida comprova o acesso por token. Nenhum deploy, migração remota, Pix real ou restore em produção é iniciado pelo diagnóstico.

## Conferência automatizada da conexão após cadastrar o Secret e a Variable

O GitHub Actions da branch de auditoria executa o diagnóstico no evento `push`, usando `CLOUDFLARE_ACCOUNT_ID` preferencialmente como Repository variable e, como alternativa, como Repository secret. Após o cadastro dos dois valores, um novo commit de documentação dispara a execução sem implantar Worker e sem ler dados pessoais. Para conferir, consulte o job `verificar` do workflow `Tigu - verificacao de codigo`, etapa `Diagnosticar acesso Cloudflare por token (se configurado)`. Se a etapa estiver pulada, a Variable não foi reconhecida ou o evento não foi `push`; se falhar, o log informa se falta token, se houve `403` ou se os recursos de staging não existem. Uma execução bem-sucedida prova apenas acesso de leitura à API e presença/ausência dos recursos; não prova deploy nem restauração de backups.

## Diagnóstico solicitado após configurar credenciais

Quando o operador informar que finalizou a variável `CLOUDFLARE_ACCOUNT_ID` e o Secret `CLOUDFLARE_AUDIT_TOKEN`, o próximo commit nesta branch executará novamente o CI. Só considerar a Cloudflare conectada se o passo **Diagnosticar acesso Cloudflare por token (se configurado)** tiver conclusão `success` e logs confirmarem a autenticação e permissões de leitura. `skipped` significa que o evento ou a branch não atenderam ao gatilho; `failure` indica credencial ausente/inválida, permissão insuficiente ou resposta remota inadequada e exige análise sem divulgar segredos.

## Reteste autorizado após correção do Account ID — 21/10/2026

O proprietário informou que ajustou `CLOUDFLARE_ACCOUNT_ID` no GitHub do TIGU. Este commit dispara novamente o workflow de `push` na branch de auditoria, para confirmar que a etapa `Diagnosticar acesso Cloudflare por token (se configurado)` lê o ID atualizado e realiza exclusivamente consultas GET. O status real deverá ser conferido no log do run correspondente; nenhuma publicação ou modificação Cloudflare faz parte desse teste.

## Provisionamento remoto autorizado — D1 e R2 de homologação

Com o Secret `CLOUDFLARE_STAGING_TOKEN` já cadastrado no repositório TIGU e o Account ID validado, foi acrescentada uma rotina de criação restrita, testada localmente em simulações, sem alterar produção:

- Verifica se o token está ativo e se os nomes `tigu-staging-db` e `tigu-staging-media` já existem na conta; não sobrescreve objetos já encontrados.
- Quando acionada na modalidade `create`, usa exclusivamente `POST /accounts/<conta>/d1/database` com nome fixo `tigu-staging-db` e `POST /accounts/<conta>/r2/buckets` com nome fixo `tigu-staging-media`.
- Confere a presença de ambos em nova consulta; não publica Worker nem manipula SQL, arquivos de clientes, DNS ou produção.
- A execução de criação por Actions só ocorre no `push` da branch `audit/tigu-primeira-validacao` com mensagem de commit **exatamente** `TIGU_PROVISION_STAGING_ONCE`. Em todos os outros pushes e PRs o passo é ignorado. O gate de ambiente `TIGU_STAGING_CREATE_APPROVED=YES` é exigido pelo script.
- `node scripts/staging-provision.mjs check` faz apenas consultas GET. Depois da criação, o deploy do Worker depende de configurações de secrets e migrações próprias e deve ser validado separadamente.

Permissões `D1 Edit` e `Workers R2 Storage Edit` têm alcance à conta selecionada pela Cloudflare e **não garantem isolamento por recurso**. Os bloqueios desse script reduzem o risco de alterações indevidas, mas não restringem o próprio token. Se o ambiente de produção estiver na mesma conta, o risco residual permanece até restringir ou revogar o token de escrita. Recursos novos podem gerar cobranças conforme o plano Cloudflare.

## Ordem de provisionamento TIGU — execução única

Autorizado pelo proprietário após configuração do token de staging. O commit que introduz esta anotação ativa uma única execução da rotina com allowlist e nomes fixos para **criar somente** D1 `tigu-staging-db` e R2 `tigu-staging-media` caso estejam ausentes. O resultado real deve ser confirmado no GitHub Actions. Não publicar Worker sem validação adicional de segredo, binding e migrações.

## Próxima fase — implantação segura do Worker tigu-staging

Após confirmação **real** da criação de `tigu-staging-db` e `tigu-staging-media`, existe uma segunda rotina restrita a `tigu-staging`:

- Somente um `push` na branch `audit/tigu-primeira-validacao` com mensagem de commit **exatamente** `TIGU_DEPLOY_STAGING_ONCE` habilita o passo; PR, commits comuns e `main` jamais publicam.
- Confere inventário Cloudflare antes de fazer qualquer escrita; recusa D1/R2 ausentes, UUID inválido, Worker pré-existente ou configuração diferente do contrato de staging.
- Usa o script revisado `staging.mjs` para preparar config efêmera, validar bindings e flags, aplicar 17 migrations no **D1 de staging**, compilar e publicar o **Worker tigu-staging**.
- Depois de publicar, gera `SESSION_SECRET` e `MSG_ENC_KEY` aleatórios, **sem imprimi-los**, e os grava diretamente como Worker secrets na Cloudflare. Não configura credenciais Mercado Pago, Meta/WhatsApp nem cron.
- A Cloudflare cria backup D1 antes de migrations remotas, mas isso **não equivale** à homologação de exportação e restauração controlada D1/R2 do projeto.

A primeira publicação do Worker pode exigir permissões adicionais de Workers Admin conforme o sistema de papéis da conta. Falha 403 é reportada; não aumentar escopo ou alterar a produção automaticamente. Se a implantação falhar após parte das operações, verificar estado real antes de retentar, pois o mecanismo recusa sobrescrever Worker já existente.

Mesmo após deploy, a **homologação funcional remota** e a **validação de recuperação de backups** continuam pendentes até testes reais, acessos fictícios e evidências verificadas.

## Disparo unico do Worker de homologação — 21/10/2026

CI local completo aprovado previamente; o proprietário autorizou disponibilizar o token `CLOUDFLARE_STAGING_TOKEN`. O commit desta anotação é o gatilho único para preparar e migrar **somente D1 staging** e tentar implantar **somente o Worker tigu-staging** com segredos próprios. Os resultados devem ser confirmados no GitHub Actions; esta anotação não representa aprovação remota nem restauração de backups.

## Recursos Cloudflare criados — evidência real de 21/10/2026

- [Run de criação D1/R2 aprovado](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39636682380): `tigu-staging-db` e `tigu-staging-media` novos, sem alterações em recursos existentes.
- [Run de deploy aprovado](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39638246202): 17 migrações D1 aplicadas, 25 assets enviados, Worker `tigu-staging` publicado e dois segredos fortes configurados no Worker.
- URL publicada pelo Wrangler: `https://tigu-staging.netssh3-0.workers.dev`.
- O CI passa a executar `staging-smoke.mjs` com apenas GET nessa URL, recusando qualquer destino fora do padrão de homologação. **Ainda é necessário confirmar o sucesso efetivo desse smoke remoto**.
- As integrações de Pix/Meta permanecem inativas e a exportação/restauração real D1+R2 segue pendente. Nunca considerar os backups homologados com base somente no backup automático de migrations.

## Próximo passo — comprovar exportação D1 da Cloudflare sem expor dados

A branch de auditoria contém `scripts/staging-d1-export-verify.mjs`, que consulta o inventário dos três recursos de staging, usa `wrangler d1 export tigu-staging-db --remote` com configuração temporária restrita, recria a exportação em banco SQLite em memória e confere tabelas obrigatórias, integridade e vínculos. Nenhum dado de cliente é impresso. O dump SQL é apagado ao final da execução; o SHA-256 gerado é somente uma impressão de integridade, **não é uma cópia durável**.

A execução remota por GitHub Actions exige um `push` na branch `audit/tigu-primeira-validacao` cujo commit tenha mensagem exatamente `TIGU_VERIFY_D1_EXPORT_ONCE`. Não executa em PR ou commits comuns, não lê outros bancos, não faz importação no D1 da Cloudflare e não salva artifact. A execução deve ser comprovada nos logs de Actions antes de considerá-la aprovada.

**Limites:** recriar o export da Cloudflare num SQLite temporário é uma evidência mais forte que o teste de migração local, mas **não comprova restauração num D1 remoto separado**, não cobre R2 nem estabelece RPO/RTO ou cópia externa de longo prazo. Mantém a verificação integral de backups como etapa pendente.
