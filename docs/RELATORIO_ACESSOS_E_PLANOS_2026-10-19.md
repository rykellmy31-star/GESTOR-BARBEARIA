# Tigu — acessos, limites e cadastro assistido

Data: 19/10/2026. Branch exclusiva: `audit/tigu-primeira-validacao`.
Base desta rodada: `55650460a471eb5cb454d3c437f8aa5666e7095d`.

## Resultado

- **136 testes Workers/D1 aprovados em 14 arquivos.**
- **18 testes de configuração/CI aprovados.**
- Build de produção e tipagem aprovados.
- Auditoria completa: **zero vulnerabilidades**.
- Validação local completa antes de cada conjunto de código enviado.
- Workflow continua somente manual; nenhum Actions foi disparado pelo desenvolvimento.
- Nenhuma alteração na main, em segredos, planos contratados, orçamentos ou produção. Nenhum deploy, migração remota, Pix ou envio real de WhatsApp. O CR Jornada não foi alterado.

## Commits

| Commit | Alteração |
|---|---|
| `81b7d1f` | Troca de senha concorrente segura e sessão vinculada à credencial validada |
| `51a36f8` | Limites de profissionais verificados atomicamente na criação e reativação |
| `9097ac2` | Cadastro assistido transacional, acesso provisório visível e teste de 15 dias |

Relatório e checklist registrados em um commit adicional de documentação.

## Acessos e recuperação

A troca de senha exige que o hash validado continue sendo o atual na confirmação da transação. Entre duas operações concorrentes baseadas na mesma senha antiga, apenas uma vence. A operação obsoleta não altera a senha nem apaga uma sessão emitida depois da operação vencedora.

Sessões de login só são gravadas se a credencial validada ainda corresponder à conta ativa. Isso impede que um login já em andamento recrie uma sessão depois de uma troca ou redefinição da senha.

A troca legítima invalida códigos de recuperação anteriores e sessões antigas na mesma transação. Redefinição de senha, desativação e mudança de papel pelo Superadmin também revogam sessões e códigos antigos, com as escritas agrupadas em uma transação.

## Limites dos planos

O limite de profissionais ativos agora participa da própria instrução de criação ou reativação. O banco serializa a disputa por uma vaga, evitando que duas requisições aprovadas por uma contagem anterior ultrapassem o limite.

Cadastrar profissional inativo continua permitido; reativá-lo acima do limite é recusado. A recusa também impede que outros campos da mesma edição sejam alterados parcialmente. Limites são isolados por empresa, e o valor -1 continua significando ilimitado.

Os planos adicionais usados nos testes foram criados apenas no D1 local de testes. Nenhum plano comercial ou assinatura de cliente real foi modificado.

## Cadastro pelo Superadmin

O fluxo anterior gerava uma senha automática e a descartava sem apresentá-la. A assinatura também era criada como ativa sem vencimento válido, sendo recusada pelas regras de acesso.

Agora o cadastro assistido:

1. Cria usuário novo, empresa, configurações, vínculo de dono, assinatura de teste, carteira e notificação na mesma transação D1.
2. Inicia teste gratuito de **15 dias**, com término registrado e acesso operacional válido. Não cria fatura nem confirma assinatura paga.
3. Mantém a senha da conta existente e recusa vincular como dono uma conta desativada sem revisão prévia.
4. Exige troca da senha inicial de todo dono novo, inclusive quando ela foi informada pelo Superadmin.
5. Retorna a senha automática apenas na resposta autenticada de criação e com `Cache-Control: no-store`. Ela não é registrada na auditoria nem armazenada em texto no banco.
6. Apresenta ao Superadmin uma janela com e-mail, endereço da empresa, data do término do teste e senha gerada, quando aplicável. A cópia depende de clique do usuário; ao fechar, a tela descarta o acesso exibido e limpa a senha do formulário.

O cadastro foi testado com falha simulada na criação da carteira: usuário, empresa e demais inserções são revertidos, sem deixar cadastro parcial.

## Verificações executadas

`npm run validate` foi executado localmente em cada conjunto de código. Ele executou:

- `npm audit --audit-level=moderate`;
- sintaxe dos scripts, teste da política de CI e testes das proteções de homologação;
- preparação/validação temporária da configuração de homologação;
- `npm run build`, que inclui `tsc -b`;
- conferência dos textos obrigatórios do frontend compilado;
- `npm test`, no runtime local Workers/D1.

A suíte foi de 122 para 136 testes do sistema nesta rodada. Foram adicionadas 14 regressões para concorrência de senhas, códigos antigos, limite de profissionais, cadastro assistido, rollback, preservação de contas existentes e autorização do Superadmin.

## Pendências

- Conferir visualmente a nova janela de acesso provisório e o fluxo completo na URL de homologação. Build e testes de API passaram; não se afirma que a publicação ou a conferência visual ocorreram.
- O botão manual do Actions continua dependendo da presença autorizada do workflow na branch padrão. A main não foi alterada. A alternativa sem consumo de Actions é continuar com `npm run validate` localmente.
- Homologação de infraestrutura, credenciais, webhooks e integrações reais depende de autorização específica. Nenhum serviço real foi ativado.
- Termos, privacidade, suporte, operação, backups e aprovação de lançamento continuam no checklist geral. Nenhum resultado local autoriza merge ou produção.
