# Tigu — validação local e controle de execuções

## Regra atual

Nenhum push, Pull Request ou agendamento dispara o workflow de validação. O único evento permitido é `workflow_dispatch`. A execução remota não foi acionada nesta rodada. Não alterar planos, orçamentos, formas de pagamento ou serviços pagos.

## Antes de enviar alterações

Use Node 22.12 ou superior. Execute `npm ci` ao preparar o ambiente ou alterar dependências e, antes de enviar cada conjunto de código, rode:

```bash
npm run validate
```

O comando executa auditoria completa de dependências, validação de sintaxe dos scripts, testes de isolamento da homologação, teste da política de CI, preparação/validação de uma configuração temporária, tipagem e build de produção, conferência dos textos obrigatórios do frontend e testes Workers/D1. Não faz deploy, migrações remotas, chamadas Pix ou envio de WhatsApp. Os arquivos de homologação locais existentes são preservados.

Após aprovação local, envie somente à branch `audit/tigu-primeira-validacao`. Commits desta etapa também usam `[skip ci]` como defesa adicional. Não use esse marcador para tentar contornar uma verificação obrigatória antes de uma integração autorizada.

## Validação manual no GitHub

O job `verificar` continua executando a mesma validação completa, com permissões somente de leitura, cache de dependências e cancelamento de execução anterior da mesma branch.

**Limitação atual:** o arquivo `.github/workflows/ci.yml` não foi encontrado na `main`. O GitHub exige a presença do workflow na branch padrão para disponibilizar o acionamento manual pela interface. A configuração está pronta na branch de desenvolvimento, mas o botão manual depende de uma futura integração **autorizada** do workflow à `main`. Não alteramos a `main` para habilitá-lo.

Referência oficial: [Executar um workflow manualmente](https://docs.github.com/pt/actions/how-tos/manage-workflow-runs/manually-run-a-workflow).

Até essa integração, a alternativa gratuita é executar `npm run validate` no ambiente de desenvolvimento. Não disparar Actions manualmente sem autorização: mesmo uma validação manual utiliza a quota de minutos da conta e pode estar sujeita às condições do plano.

## Antes de integrar à main

- Validar a versão exata candidata à integração e registrar commit, comandos e resultados no relatório.
- Confirmar os testes de homologação necessários e revisar as pendências comerciais e de produção.
- Exigir aprovação explícita do proprietário para integrar à `main`.
- Quando a validação manual estiver habilitada e autorizada, manter o check `verificar` como verificação exigida pelas regras do repositório. A proteção de branch não foi configurada ou alterada nesta rodada.

Nenhum check remoto foi apresentado como aprovado para os commits desta rodada: o resultado confirmado é o da validação local.
