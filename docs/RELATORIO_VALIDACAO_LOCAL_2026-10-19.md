# Tigu — desenvolvimento com validação local

Branch: `audit/tigu-primeira-validacao`.
Base da rodada: `608aa7faf2a8132aa03c521f12762c55b5e7ca2d`.
Data: 19/10/2026.

## Resultado confirmado

- **122 testes Workers/D1 aprovados em 11 arquivos.**
- **18 testes Node de configuração/CI aprovados.**
- `npm run build` aprovado, incluindo `tsc -b` para frontend, API, testes e configurações Node.
- Auditoria completa: **zero vulnerabilidades**.
- Todos os conjuntos de código foram validados localmente antes do envio ao GitHub.
- **Nenhum GitHub Actions foi acionado automaticamente pelos commits da rodada ou manualmente pelo desenvolvimento.** A consulta de execuções da branch continuou mostrando o commit anterior `608aa7f` como a execução mais recente.
- Não houve alterações na main, segredos, planos, orçamentos, formas de pagamento, recursos de produção ou no CR Jornada. Não houve deploy, migração remota, cobrança Pix ou envio de WhatsApp.

## Commits

| Commit | Alteração |
|---|---|
| `98c5f1d` | Comando único de validação local e remoção do push automático |
| `f50ea8b` | Feriados isolados por empresa, grade consistente e remarcação sem conflito com a própria reserva |
| `43e0640` | Regra reforçada: workflow somente manual, sem disparo por Pull Request |
| `b0e52e2` | Pedidos e estoque transacionais, sem venda acima do saldo ou devolução duplicada |
| `0049513` | Edição de produtos/profissionais/serviços e vínculos restritos à empresa |
| `ed022e9` | Aprovação obrigatória de folgas, fuso correto e bloqueios concorrentes seguros |
| `408506a` | Teste que impede reintroduzir eventos automáticos de CI |

Este relatório, a política de custos, o README e o checklist são registrados em um commit adicional de documentação.

## Detalhes das correções

### Execuções e custos

O workflow aceita somente `workflow_dispatch`, com permissões de leitura e cancelamento de uma execução anterior da mesma branch. Não há gatilhos push, Pull Request ou agendamento. O job `verificar` continua executando a validação completa. Os commits posteriores à regra reforçada também usam `[skip ci]` como defesa adicional.

`npm run validate` usa o mesmo conjunto de verificações no desenvolvimento e no workflow manual. A preparação de homologação ocorre em diretório temporário, sem substituir a configuração local existente. O build já verifica os tipos; eliminou-se a repetição desnecessária do typecheck.

A execução manual não foi disparada para testar o workflow, evitando consumir minutos remotos. Não foi alterada nenhuma configuração de cobrança do GitHub.

### Agenda

- Um feriado geral de uma empresa não fecha a agenda de outra.
- Horários oferecidos a partir de um início como 09:05 são aceitos pela criação da reserva.
- Remarcação permite sobreposição com o próprio horário anterior e continua recusando sobreposição com outro cliente.
- Dias inexistentes e meses inválidos não provocam erro interno na consulta de disponibilidade.

### Loja e estoque

- Corrigidos os parâmetros da consulta de produtos do pedido, que reutilizavam a posição da empresa.
- A restrição do banco impede estoque negativo e reverte o pedido inteiro sob disputa da última unidade ou quantidade acumulada de itens repetidos.
- POST e PATCH de status seguem a mesma regra. Pedido cancelado não volta a pago/entregue por um alias alternativo.
- Cancelamentos concorrentes devolvem cada item uma única vez. Status, notificação, movimentos e reposição ficam na mesma transação.
- Teste com falha simulada no movimento de estoque comprova a reversão de status e notificação.
- Ajuste manual sem saldo retorna conflito e não grava movimentação fictícia.

### Catálogo

- Corrigido o uso misto de parâmetros SQL anônimos e numerados nas edições de produtos, serviços e profissionais.
- Serviços selecionados para um profissional e profissionais selecionados para um serviço precisam pertencer à empresa autenticada.
- O cadastro e a edição de serviços agora processam os vínculos informados, sem confundir o ID do serviço com o da empresa.
- Um vínculo recusado não altera os demais campos nem apaga a associação válida anterior.

### Folgas e solicitações de bloqueio

- Todos os aliases verificam a permissão definida pelo dono e aguardam aprovação, inclusive pedidos de dia inteiro.
- Intervalos incompletos, invertidos e datas inválidas são recusados.
- Todos os aliases administrativos usam a mesma validação de conflito e conversão do fuso local.
- Aprovação, criação do bloqueio e reserva dos slots são transacionais. Duas aprovações simultâneas não criam dois bloqueios.
- Slots de um dia inteiro são inseridos por uma única instrução SQL com `json_each`, evitando uma instrução por intervalo.

## Comandos realmente executados

- `npm run validate` antes de enviar cada conjunto de código; esse comando executou auditoria, testes Node, preparação/validação local de homologação, build/tipagem, conferência do frontend e a suíte Workers/D1.
- `npx vitest run tests/block-request-approval.test.ts` durante a investigação e correção dos dados de preparação do teste de conflito.
- Leitura e validação YAML local do workflow: somente `workflow_dispatch`, permissões somente leitura e chamada ao validador completo.

Houve falhas locais na preparação do novo teste de bloqueio por ausência de campos obrigatórios do agendamento. Os dados foram corrigidos e o teste específico, seguido da suíte completa, passou. Nenhuma versão com essas falhas foi enviada.

## Pendências reais

1. **Botão de execução manual no GitHub:** a configuração está preparada na branch, mas o workflow não existe na main. A interface depende de uma integração autorizada do workflow na branch padrão. Não se alterou a main para habilitar o botão. A alternativa sem consumo de Actions continua sendo `npm run validate` localmente.
2. **Verificações antes de integrar:** manter validação da versão exata candidata e aprovação explícita do proprietário. A proteção de branch não foi alterada; não se afirma que regras remotas foram configuradas.
3. **Homologação visual e ponta a ponta pela URL isolada:** ainda depende do ambiente autorizado. Estes resultados confirmam o código e os testes locais, não uma publicação na Cloudflare.
4. **Integrações reais:** credenciais, webhooks, operação Mercado Pago/Meta e políticas de restituição exigem validação e autorização específicas. Nenhum serviço real foi ativado.
5. **Lançamento:** termos, privacidade, operação de suporte, backups e aprovação de produção permanecem no checklist de lançamento. A validação local não autoriza merge ou publicação.

Mais detalhes de execução: [Validação local e custos](VALIDACAO_LOCAL_E_CUSTOS.md).
