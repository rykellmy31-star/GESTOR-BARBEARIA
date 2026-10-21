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
