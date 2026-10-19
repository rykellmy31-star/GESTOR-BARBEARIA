# Tigu — bloqueios de agenda e acesso dos profissionais

Data: 19/10/2026. Branch exclusiva: `audit/tigu-primeira-validacao`.
Base: `578a41cfaea523a566f0ae42f668ff1952b3c43d`.

## Alterações

### Bloqueios de intervalo

- `/admin/blocks` e `/admin/bookings/block` usam o mesmo serviço.
- Corrigido o número de parâmetros SQL do caminho usado pela tela; a resposta agora inclui o protocolo exibido na confirmação.
- Datas devem existir, fim deve ser posterior ao início e os minutos inicial/final devem ser informados juntos. Intervalo horário deve terminar no mesmo dia.
- Profissional precisa estar ativo e pertencer à barbearia; o alias antigo não pode reservar slots de outra empresa.
- Inserção e reserva dos slots acontecem em uma transação. Slots são inseridos via `json_each`, permitindo o dia inteiro sem centenas de comandos no batch.
- Conflitos com atendimentos existentes são recusados mesmo se um registro legado não tiver slots. O atendimento existente é preservado.

### Folgas, férias e feriados

- Os dois caminhos validam datas reais e ordem do período.
- Formatos camelCase e snake_case são normalizados; campos equivalentes contraditórios são recusados.
- `barber_id` é reconhecido como alias de `barberId`, evitando que uma folga individual seja interpretada como geral por desconhecimento do campo.
- Fim omitido usa a data inicial. Ano bissexto válido é aceito.
- Validação de pertencimento também ocorre na gravação; profissional estrangeiro é recusado pelo caminho antigo e pelo atual.
- Bloqueio geral de dias continua sem cancelar ou remarcar automaticamente atendimentos existentes. A operação da barbearia deve tratar esses atendimentos explicitamente.

### Painel do profissional

- Membership de barbeiro só concede acesso se o profissional vinculado estiver ativo e pertencer à mesma empresa.
- Vínculos legados estrangeiros, sem profissional ou desativados são recusados, inclusive com sessão criada antes da desativação.
- A mudança não bloqueia o proprietário nem os profissionais de outra empresa.
- Agenda transforma início e fim do período local para UTC com o fuso da barbearia, incluindo corretamente atendimentos do fim da noite.
- Datas inexistentes e quantidade de dias inválida retornam 400, evitando erro interno.

### Proteção de sobreposição no banco

- Nova migração `0008_booking_overlap_guard.sql` impede INSERT/UPDATE de atendimentos sobrepostos para o mesmo profissional em estados que ocupam a agenda.
- Complementa a trava por slots: passos de sete minutos ou horários com minutos diferentes também são protegidos pelo intervalo real.
- Compara instantes via `julianday`, incluindo equivalência entre timestamps com e sem milissegundos.
- Adjacência e registros encerrados/cancelados permanecem permitidos. O próprio atendimento é excluído da busca na edição.
- Conflitos retornam 409 nas funções de criação, remarcação, confirmação e bloqueios; falhas revertem a transação.
- A migração não apaga nem corrige sobreposições legadas. Confirmar um registro legado conflitante retorna 409 sem gravar notificações falsas.
- **Proteção validada somente localmente. Depende de aplicar a migração 0008 no banco de destino. Nenhuma migração remota foi executada.**

## Commits

| Commit | Alteração |
|---|---|
| `b5b36ab` | Bloqueios de intervalo unificados, SQL corrigido e isolamento entre empresas |
| `0047388` | Datas, períodos e aliases das folgas validados |
| `edf905a` | Acesso condicionado ao profissional ativo e agenda no fuso local |
| `25cac6d` | Proteção de sobreposição no D1, tratamento 409 e suíte principal com as novas migrações |

Este relatório e o checklist são registrados em um commit adicional de documentação no histórico da branch.

## Verificações executadas localmente

- Testes específicos após cada implementação: 8 de bloqueios de intervalo; 14 de intervalos e folgas; 10 de acesso/agenda e pedidos de folga; 8 de sobreposição.
- Build e tipagem executados antes de enviar cada conjunto de código.
- Auditoria sem vulnerabilidades e 18 testes de configuração/CI aprovados.
- Migrações 0001–0008 aplicadas com sucesso via Wrangler em banco local isolado, usando `--local` e diretório próprio de persistência.
- `npm run validate` aprovado: **182 testes Workers/D1 em 21 arquivos**, **18 testes de configuração/CI**, tipagem, build, auditoria sem vulnerabilidades e validação isolada de homologação.
- Depois da validação completa, a suíte principal foi atualizada para carregar também as migrações 0007 e 0008: **63 testes aprovados** nessa execução adicional, seguida de novo build aprovado. Esses 63 testes já fazem parte do total de 182, não são casos novos.
- Não foi executada validação remota do novo HEAD no Actions; todas as evidências de execução desta rodada são locais.

## Restrições respeitadas e pendências

- Nenhuma alteração na main, em segredos, planos contratados, formas de pagamento, orçamentos ou produção. Nenhum deploy, Pix real, envio real de mensagens ou recurso pago foi ativado. Outros projetos não foram alterados.
- Workflow permanece apenas manual, com teste que rejeita eventos automáticos. Nenhum Actions foi acionado nesta rodada.
- O botão manual do GitHub depende de presença autorizada do workflow na branch padrão; esta etapa permanece pendente, com validação local disponível.
- Aplicar as migrações pendentes (incluindo 0007 e 0008) no banco remoto correto exige autorização e homologação. Antes da implantação, auditar sobreposições existentes e preparar tratamento operacional; a migração preserva os dados legados.
- Ampliar os testes de concorrência entre cancelamento, remarcação, mudança de status e folgas de dia inteiro. A trava de sobreposição não substitui a revisão das transições de estado.
- Conferência visual e testes end-to-end em homologação, integrações externas de Mercado Pago/WhatsApp, recuperação de acesso e processos de privacidade continuam necessários antes da liberação comercial.
