# Tigu — concorrência e validação HTTP local

Data: 19/10/2026. Branch: `audit/tigu-primeira-validacao`.
Base da rodada: `d0ecaae88de1447970811b12c574f47122e23b10`.

## Resultado e limites

O código recebeu novas proteções de concorrência e uma validação HTTP local reproduzível. **Não declarar o projeto 100% pronto para produção:** homologação visual e externa, credenciais autorizadas, implantação e decisões operacionais ainda estão pendentes.

Nenhuma alteração na main, em segredos, orçamentos, planos contratados ou produção. Nenhum deploy, migração remota, Pix real ou envio real de WhatsApp foi realizado. Outros projetos não foram alterados.

## Alterações

### Operações concorrentes no mesmo atendimento

A migração 0009 adiciona um identificador da operação vencedora. Cancelamento, remarcação e mudança de status conferem estado, versão e identificador antes de atualizar. Apenas a operação que grava seu identificador pode alterar slots e inserir notificações dentro da transação.

- Confirmação obsoleta não restaura atendimento cancelado.
- Remarcação obsoleta não remove os slots de outra operação nem recria slots após cancelamento.
- Dois cancelamentos não repetem motivo, versão ou aviso.
- Falha em uma etapa reverte horários, versão, identificador e slots.
- Cancelamento incrementa a versão na própria transação, sem uma atualização posterior separada.

Os testes forçam as duas operações a ler o mesmo estado antes de continuar, evitando depender apenas da ordem casual do runtime.

### Mensagens, versões e créditos

- Snapshot antigo é recusado antes de cancelar ou programar jobs.
- A inserção confere novamente horário, estado e versão no D1.
- Limpeza de jobs de uma operação antiga não alcança versões futuras.
- Dispatch descarta versões antigas e confere versão/estado novamente no claim.
- Cancelamento ou descarte que perdeu a disputa para outro Worker não sobrescreve envio assumido nem libera seus créditos.
- Empresa ativa, assinatura válida, permissão do plano e cota mensal são conferidas novamente no claim. Envios assumidos contam para a cota, evitando ultrapassá-la enquanto o provedor responde.
- Mensagens já em andamento continuam sujeitas à conciliação existente; a aplicação não promete desfazer algo já aceito pelo provedor.
- Texto do Superadmin foi atualizado para orientar a consulta de mensalidades Pix, sem descrever a cobrança como exclusivamente manual.

Nenhum provedor real foi chamado. Os testes usam dados, créditos e provedor fictícios no banco local.

### Folgas de dia inteiro

A migração 0010 adiciona o dia local validado à reserva. Novas reservas, remarcações e bloqueios horários conferem as folgas também na transação de gravação. Assim, fechar o dia entre a leitura da disponibilidade e o commit impede a nova reserva sem deixar cliente, slot ou notificação parcial.

Reservas gravadas antes da folga permanecem existentes e podem ser confirmadas/canceladas conforme as regras. Fechar um dia não cancela clientes automaticamente. Folga individual não bloqueia colegas ou outras barbearias. Dados legados são preservados.

### Validação HTTP reproduzível

Novo comando `npm run test:local-e2e`, documentado em `GUIA_VALIDACAO_LOCAL.md`. Inicia Worker/HTML/D1/R2 temporários apenas em loopback, aplica todas as migrações e faz 24 verificações HTTP. Ao terminar, encerra o Worker e remove o ambiente temporário.

Cobre cadastro, teste de quinze dias, vencimento e renovação bloqueada para Pix real, agenda, estoque, isolamento, Superadmin e cadastro assistido. Não aceita endereço remoto nem argumentos de deploy. Não utiliza recursos remotos nem aciona Actions.

## Commits

| Commit | Alteração |
|---|---|
| `a2fc45e` | Operações condicionais de cancelamento, remarcação e status |
| `082c37a` | Fila por versão e proteção das reservas de envio |
| `fe0f932` | Folgas conferidas na gravação da reserva |
| `5525ddf` | Validação HTTP local com ambiente e dados efêmeros |
| `eb135bb` | Acesso e cota revalidados antes do envio; proteções de status e créditos |

Este relatório e o guia de validação local são registrados em um commit adicional de documentação no histórico da branch.

## Execuções locais

- Testes novos de concorrência com barreiras controladas e falhas simuladas.
- Suíte principal de 63 testes executada em conjunto com as regressões após as alterações.
- `npm run validate` após as proteções de agenda: 200 testes Workers/D1 em 24 arquivos, 18 de configuração/CI, build e auditoria sem vulnerabilidades.
- `npm run test:local-e2e`: **24 verificações HTTP aprovadas**, após build, com banco novo contendo as dez migrações. A execução foi repetida com sucesso após a revisão final das permissões/cotas.
- Migrações 0001–0010 executadas com sucesso via Wrangler `--local` em persistência isolada.
- Validação final após a revisão de permissões/cotas: **205 testes Workers/D1 em 24 arquivos + 18 testes de configuração/CI**, tipagem e build aprovados, auditoria de dependências com zero vulnerabilidades.
- Build e testes locais antes de enviar cada conjunto de código. A suíte não aciona qualquer recurso remoto.

## Pendências que impedem a conclusão de produção

| Item | Situação |
|---|---|
| Conferência visual no navegador | Bloqueada neste ambiente: download do Chromium truncado; alternativa por pacote recusada pelas permissões do sistema. HTTP e build não substituem inspeção visual. |
| Homologação Cloudflare e HTTPS | Requer acesso autorizado à conta e recursos gratuitos isolados disponíveis. Nenhum recurso remoto foi criado. |
| Migrações e dados remotos | Aplicar migrações pendentes, incluindo 0007–0010, somente no banco correto, com autorização, backup e auditoria dos dados legados. |
| Mercado Pago e WhatsApp | Credenciais, webhooks e condições operacionais precisam de validação externa; ativação real permanece proibida pelas instruções do proprietário. |
| Políticas e operação comercial | Aprovar termos, privacidade, retenção, recuperação de acesso, backup e suporte antes de receber clientes reais. |
| Integração à main e publicação | Dependem de autorização explícita. Workflow manual preparado na branch; habilitação na branch padrão continua pendente. |

Alternativa gratuita já entregue: executar a suíte e o fluxo HTTP completos no ambiente local, sem utilizar minutos do GitHub Actions. Isso reduz os bloqueios técnicos, mas não comprova os itens externos desta tabela.
