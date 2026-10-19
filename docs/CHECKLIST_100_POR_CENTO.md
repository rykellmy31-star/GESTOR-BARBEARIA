# TIGU — Checklist objetivo para operação comercial

> Acompanhar nesta branch de desenvolvimento. **Build verde não significa "100% pronto".** Não habilitar pagamentos, mensagens reais ou liberar clientes antes de concluir os itens obrigatórios.

## Validado no código e por testes automatizados

- [x] Catálogo, agendamentos, controle de conflitos e isolamento das barbearias.
- [x] Carteira de créditos: reserva, captura, estorno e recarga Pix idempotentes no banco.
- [x] Verificação de valor, moeda e referência de Pix com provedor simulado.
- [x] Lembretes agendados, remarcações, cancelamentos e isolamento dos retornos Meta, em simulação.
- [x] Tratamento conservador de timeout de envio (não reenviar sem confirmação).
- [x] Conciliação manual de mensagem incerta, com supervisão e justificativa.
- [x] Contato comercial editável pelo Superadmin, com permissão e possibilidade de ocultar.
- [x] Exclusão individual de interessados com motivo, política inicial de retenção configurável (30–365 dias) e limpeza do banco D1 testada.
- [x] Prévia visual responsiva independente de API com dados fictícios.
- [x] Cadastro de usuário, empresa, assinatura e carteira em uma só transação D1.
- [x] Rotas do Superadmin normalizadas para não duplicar o prefixo HTTP.
- [x] Senha temporária exige alteração antes de acessar os painéis. Recuperação pública em produção não inventa entrega de código que não existe.
- [x] Ambiente de homologação preparado com recursos separados e bloqueio de provedores reais.
- [x] Validação estrita do Worker de homologação impede rotas externas, bindings D1/R2 extras e cron; o CI testa os bloqueios.
- [x] Diagnóstico remoto somente-leitura pronto para conferir Worker, D1, R2, secrets e permissões sem criar dados.
- [x] Sessões de produção falham sem SESSION_SECRET forte; health expõe somente flags booleanas de prontidão.

- [x] Recuperação de senha com consumo único transacional; repetição no mesmo segundo não troca a senha nem revoga sessões posteriores.
- [x] Cadastro de equipe não vincula e-mails globais sem consentimento; reset da barbearia não alcança Superadmin nem contas de outras empresas.
- [x] Colisão de chave de agendamento não revela reserva, cliente ou token de cancelamento de outra empresa.
- [x] Senhas provisórias geradas por fonte criptográfica, com troca obrigatória e revogação de códigos antigos no reset.

## Ainda necessário antes da entrega comercial

### Infraestrutura e implantação (necessita conta Cloudflare autorizada)

- [ ] Criar banco D1, bucket R2 e Worker de homologação na conta Cloudflare.
- [ ] Aplicar migrations remotas no banco **correto**, cadastrar superadmin de teste e configurar secrets exclusivos.
- [ ] Publicar e validar end-to-end login, alteração de senha, cadastro, agenda, catálogo, carrinho, estoque e painéis via URL de homologação.
- [ ] Rodar o diagnóstico `STAGING_URL=https://tigu-staging.SUA_SUBCONTA.workers.dev npm run staging:smoke` **após** configurar secrets e publicar. Preparar contas fictícias apenas após isolamento confirmado.
- [ ] Configurar projeto Cloudflare de produção separado, domínios, cookies, backups, observabilidade, proteção contra abuso e rollback.
- [ ] Confirmar a publicação real do Cloudflare Pages. Build do GitHub não garante que a versão mais recente já está visível no endereço.

### Pagamentos e assinatura (dependências externas)

- [ ] Configurar credenciais e webhook reais do Mercado Pago, testar Pix aprovado, estornado, atrasado e conciliado em banco real.
- [ ] Testar upgrade, mensalidade vencida, QR Code expirado, disputa de pagamentos e repetição de webhook em homologação controlada antes de aceitar Pix real.
- [x] Reemissão segura de Pix vencido: primeiro consulta o Mercado Pago, libera outro apenas com status terminal e preserva fatura incerta quando há timeout.
- [x] Atualização atômica da assinatura, da fatura e do plano da empresa na confirmação do pagamento.
- [ ] Definir regra comercial para downgrade, tratamento manual de faturas criadas com resposta incerta e eventuais pagamentos duplicados; homologar estornos.
- [x] Permitir que o Superadmin altere preços e limites de Start/Pro/Scale no D1; a página pública lê os valores atuais do backend.
- [x] Start por R$ 19,99/mês depois de 15 dias grátis; novos cadastros têm término registrado no D1, com bloqueio de novas operações ao expirar e aviso no painel. Sem cobrança automática.
- [x] Página de assinatura permite escolher Start, Pro ou Scale e solicitar upgrade por Pix; o plano só é alterado após verificação real do pagamento (sem pró-rata ou débito automático).
- [x] Faturas da assinatura registradas separadamente da recarga de WhatsApp e verificadas por referência, valor, moeda, método e id do Mercado Pago.
- [x] Painel de mensalidades Pix no Superadmin: indicadores, busca literal por código/barbearia, filtros e destaque de cobranças travadas, sem botões de liberação manual.
- [x] Migração 0004 preserva preços Start já personalizados e concede tolerância a testes legados sem data final.
- [x] Formulário para solicitar contratação Pro/Scale, consentimento explícito, registro no D1, prevenção de duplicidade e lista de interessados restrita ao Superadmin.
- [x] Verificar token Cloudflare Turnstile no Worker, sem enviar contatos em produção quando as chaves não estiverem configuradas.
- [ ] Configurar Turnstile por domínio no Cloudflare e testar o formulário publicado; incluir regras WAF quando necessário.
- [ ] Revisar juridicamente e aprovar a política inicial de retenção dos interessados (padrão proposto: 180 dias), a comunicação ao titular e procedimentos LGPD antes de receber dados reais.
- [ ] Publicar Termos/Política de Privacidade finais e mecanismo operacional de atendimento a solicitações de titulares de dados.
- [x] Cobrança Pix **mensal com pagamento iniciado pelo cliente** e liberação automática após confirmação verificada pelo Mercado Pago no Worker; faturas separadas de recargas, com migração 0005.
- [ ] Configurar credenciais e webhooks reais do Mercado Pago no Worker de produção e homologar end-to-end. **Ainda não foi realizado Pix real.**
- [ ] Avaliar habilitação de Pix Automático/recorrente na conta Mercado Pago, com autorização do pagador. A cobrança desta etapa não debita sem nova ação do cliente.
- [ ] Revisar suporte a estornos/chargebacks, timeouts de criação Pix e restituições antes do lançamento comercial.
- [ ] Reconciliar valores cobrados ao cliente, custos Meta e margem da plataforma com relatórios financeiros auditáveis.

### WhatsApp e conformidade

- [ ] Validar acesso à Meta Cloud API, aprovação dos modelos de mensagem, onboarding de números por barbearia e condições de faturamento centralizado.
- [ ] Testar disparo/entrega/falha/timeout e consentimento real com números de teste autorizados.
- [ ] Definir rotina operacional de revisão de mensagens incertas, com prazo para desbloquear reservas.
- [ ] Revisar e disponibilizar Termos de Uso, Política de Privacidade, proteção LGPD e aceite explícito no cadastro.
- [ ] Configurar recuperação de acesso self-service com provedor de e-mail transacional ou manter suporte verificado formalmente.
- [x] Limites de autenticação, cadastro, recuperação e agendamento persistidos atomicamente no D1 (migração 0006), com fingerprint e limpeza de janelas antigas. WAF/Turnstile por domínio ainda exige configuração externa.
- [x] Auditoria completa de dependências (produção e desenvolvimento) com zero vulnerabilidades após atualização do React Router, ferramentas Workers/Vitest e Tailwind/PostCSS.

### Critério para integrar à main

- [ ] Validação completa da versão candidata registrada; check manual `verificar` aprovado quando habilitado e autorizado, sem disparar Actions automaticamente.
- [ ] Testes end-to-end de homologação aprovados com dados fictícios.
- [ ] Aprovação explícita do proprietário do Tigu antes do merge.
- [ ] Checklist de produção concluído antes de ativar clientes ou recursos financeiros reais.

## Rotina de desenvolvimento

Trabalhar exclusivamente em `audit/tigu-primeira-validacao`, reportar ao proprietário cada alteração visível na prévia visual após finalizar, e atualizar este checklist quando um bloqueio realmente for resolvido. Não alterar o repositório CR Jornada.

## Rodada de validação local e custos

- [x] Workflow sem eventos automáticos e com possibilidade de acionamento manual preparada.
- [x] Comando `npm run validate` preserva auditoria, tipagem, build, autoria, homologação e testes antes do envio.
- [x] Regressões para feriados entre empresas, remarcações, estoque concorrente, cancelamentos e edição do catálogo.
- [x] Pedidos de folga sempre aguardam decisão; todos os aliases de aprovação respeitam fuso, conflitos e consumo único.
- [ ] Habilitar botão manual pela integração autorizada do workflow na branch padrão. Não executado nesta rodada.

## Rodada de acessos e limites

- [x] Troca de senha invalida recuperação antiga e recusa operações concorrentes obsoletas.
- [x] Login não cria sessão com credencial substituída enquanto a verificação estava em andamento.
- [x] Criação e reativação de profissionais respeitam capacidade atomicamente no D1.
- [x] Cadastro assistido completo em uma transação, com teste de 15 dias e senha provisória apresentada ao Superadmin.
- [x] Reset e desativação pelo Superadmin revogam sessões e códigos antigos.
- [ ] Conferência visual da janela de acesso provisório na homologação autorizada.

## Rodada de agenda e proteção de acessos

- [x] Fusos reconhecidos pelo runtime e horários reais validados no servidor.
- [x] Ordem de abertura/fechamento e expediente/pausa verificada, inclusive em edição parcial.
- [x] Edições concorrentes dos horários não combinam expedientes incompatíveis.
- [x] Vínculos do Superadmin exigem conta ativa e profissional ativo da empresa selecionada.
- [x] Migração 0007 protege a última conta Superadmin ativa contra desativação, rebaixamento e exclusão; transações recusadas preservam os acessos.
- [x] Migrações 0001–0007 executadas em banco local isolado.
- [ ] Aplicar a migração 0007 no banco remoto correto após autorização; proteção ainda não implantada remotamente.

## Rodada de bloqueios e painel do profissional

- [x] Bloqueios horários unificados, com SQL corrigido, protocolo na resposta e reserva transacional de slots.
- [x] Caminho antigo de bloqueios exige profissional da mesma empresa, ativo para bloqueio de intervalo.
- [x] Folgas/férias validam datas reais, ordem do período e aliases consistentes.
- [x] Profissional desativado ou vínculo inválido perde acesso ao painel mesmo com sessão já existente.
- [x] Agenda do profissional consulta o intervalo no fuso local da barbearia, incluindo o fim da noite.
- [x] Migração 0008 protege contra sobreposição real de intervalos em grades diferentes, com reversão transacional dos conflitos.
- [x] Migrações 0001–0008 executadas em banco local isolado.
- [ ] Aplicar migração 0008 remotamente após autorização e auditoria dos dados legados; não implantada nesta rodada.
- [x] Transições de status, cancelamento e remarcação com disputa controlada; folgas conferidas no commit (migrações 0009 e 0010).


## Rodada de concorrência e validação HTTP

- [x] Apenas a mutação vencedora altera slots, versão e notificações do atendimento.
- [x] Snapshot antigo de mensagem não cancela nem programa o lembrete de uma versão mais recente.
- [x] Claim de envio revalida empresa, assinatura, plano, cota e versão; operações perdedoras preservam os créditos do envio assumido.
- [x] Validação HTTP reproduzível em Worker/D1/R2 locais: 24 verificações, incluindo vencimento do teste grátis e cancelamento público preservado.
- [x] Migrações 0001–0010 aplicadas em banco local novo e isolado.
- [ ] Aplicar migrações 0009 e 0010 no banco remoto autorizado; não implantadas nesta rodada.
- [ ] Conferir a interface em navegador funcional; download e instalação de navegador bloqueados no ambiente atual.

## Rodada de isolamento da configuração de homologação

- [x] UUID do D1 comparado sem diferenciar maiúsculas/minúsculas, impedindo reutilização do banco de produção por variação de escrita.
- [x] `staging:prepare` valida o contrato completo antes de criar o arquivo; templates inseguros não deixam configuração gravada.
- [x] Opções adicionais de observabilidade são rejeitadas pelo contrato de homologação.
- [x] Regressões locais cobrem a colisão de UUID e a recusa de preparação sem efeitos no disco; nenhuma operação remota executada.
