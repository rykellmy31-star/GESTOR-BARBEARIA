# Tigu — relatório técnico de preparação para lançamento

Data: 19/10/2026. Branch exclusiva: `audit/tigu-primeira-validacao`.
Base desta rodada: `50f48dcce1ffb24eba69575494d6208d60c5846b`.

## Resultado

Foram corrigidos caminhos de tomada de contas globais e vazamento entre barbearias, reforçada a recuperação de senha e substituídos os limites em memória por contadores atômicos no D1. A auditoria completa de dependências passou de 16 alertas (incluindo dois críticos nas ferramentas) para **zero**.

O código está preparado para a próxima homologação, mas **não equivale a um lançamento aprovado**. Não foram alterados main, segredos, produção ou recursos do CR Jornada. Não houve Pix real, deploy ou migração remota.

## Alterações

- Recuperação: o consumo do código, a alteração da senha e a revogação das sessões dependem da mesma transação. Uma repetição concorrente no mesmo segundo não substitui a senha escolhida pelo primeiro pedido, nem encerra sessões criadas depois. Corpos JSON inválidos e senhas acima de 128 caracteres são recusados antes do hash.
- Agendamentos: a recuperação de uma reserva após colisão de idempotência também filtra a empresa. Colisão com outra barbearia retorna conflito, sem revelar reserva, cliente ou token de cancelamento. A transação revertida não deixa cliente órfão.
- Equipe: conhecer um e-mail global não permite vinculá-lo ao painel de uma barbearia. Reset pelo painel não alcança Superadmin nem contas associadas a outras empresas. A criação de credenciais não rebaixa um dono existente para barbeiro. Profissionais de outra empresa são recusados antes da criação de usuário.
- Senhas provisórias: geradas por fonte criptográfica; novos funcionários precisam trocá-las. O reset de um funcionário exclusivo revoga sessões e códigos antigos numa transação.
- Proteção contra abuso: tentativas de login, cadastro, recuperação e agendamento persistidas no D1, compartilhadas entre Workers. Chaves com fingerprint, sem IP/e-mail em claro; limpeza de janelas antigas no cron existente. A migração 0006 foi criada e testada, sem execução remota.
- Dependências: React Router 7.18.4, Vitest 4.1.11, plugin Workers 1.4.5, Wrangler 4.151.2, tipos Workers 5.20261019.1 e Tailwind/PostCSS 4.3.3. Configuração de testes e CSS adaptada; requer Node 22.12 ou superior. O CI agora audita também dependências de desenvolvimento e falha com alertas moderados ou superiores.

## Commits desta rodada

| Commit | Entrega |
|---|---|
| `9ec1372` | Consumo transacional de código de recuperação |
| `ae7d2af` | Integração da proteção na redefinição de senha |
| `35d44ed` | Regressões de recuperação e concorrência no D1 |
| `78ed021` | Isolamento de idempotência de agendamento |
| `b619485` | Regressão de colisão entre barbearias |
| `dbe8125` | Correção de dependências de produção |
| `bf36320` | Validação de corpos e limites de senha |
| `fdd5167` | Proteção de contas globais e credenciais de equipe |
| `873ef17` | Limites persistentes e migração 0006 |
| `fcfbfc1` | Atualização de ferramentas, CSS e auditoria completa |

Este relatório e o checklist são registrados em um commit adicional de documentação.

## Verificações locais aprovadas

- Instalação limpa: `npm ci --ignore-scripts`.
- Tipagem e build de produção: `npm run build`.
- Workers/D1: **102 testes em 8 arquivos**, incluindo 21 regressões adicionadas nesta rodada.
- Proteções de homologação: **17 testes**, além da sintaxe dos scripts e preparação/validação local da configuração isolada.
- Auditoria completa: `npm audit --audit-level=moderate`, **zero vulnerabilidades**.
- O novo runtime de testes deixou de emitir os avisos de leitura de requisição após o envio da resposta observados na versão anterior.

Os testes financeiros usam respostas controladas do provedor. Eles não comprovam processamento de Pix real nem entrega de WhatsApp real.

## Verificação no GitHub

Consultar o Actions pelo SHA exato da branch; execuções anteriores não substituem a execução do último commit. A execução das ferramentas atualizadas está em:

https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions?query=branch%3Aaudit%2Ftigu-primeira-validacao

## Pendências antes de lançar

1. Homologação isolada na Cloudflare: criar/confirmar D1, R2 e Worker exclusivos; aplicar migrações e publicar apenas mediante autorização. A migração **0006 deve preceder a publicação** do código com limites persistentes.
2. Testar pela URL de homologação: cadastro, login, troca obrigatória de senha, calendário, equipe, produtos, estoque, término do teste de 15 dias, planos, Superadmin e responsividade em celular/computador. A compilação e os testes de API passaram; a validação visual em navegador não foi concluída neste ambiente, pois o navegador não estava disponível e seu download falhou.
3. Integrações externas: configurar credenciais e webhooks por canal seguro, somente com autorização; homologar Pix aprovado, expirado, atrasado, repetido e estornado antes de aceitar clientes pagantes. Validar a operação Meta separadamente, se incluída no lançamento.
4. Decisões comerciais: política de downgrade, restituições, pagamentos de faturas antigas e prazo de atendimento para criação de Pix com resposta incerta. O sistema preserva o estado incerto para evitar duplicação; não inventa aprovação.
5. Identidade e suporte: contas globais existentes exigem vínculo seguro pelo suporte/Superadmin. Um fluxo de convite com consentimento continua como evolução; o painel não vincula contas existentes apenas pelo e-mail. Recuperação em produção permanece via suporte verificado enquanto não houver provedor de e-mail transacional configurado.
6. Operação: termos, política de privacidade, rotina de atendimento, domínio, backups, alertas, WAF/Turnstile por domínio e plano de rollback precisam de validação antes da abertura pública.

A integração à main e a ativação de recursos reais continuam dependendo de autorização explícita do proprietário.
