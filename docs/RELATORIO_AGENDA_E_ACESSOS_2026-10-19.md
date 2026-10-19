# Tigu — validação da agenda e proteção de acessos

Data: 19/10/2026. Branch: `audit/tigu-primeira-validacao`.
Base desta rodada: `118643c11f5486c969d6ffb456a390017e5bc655`.

## Alterações

### Agenda e configurações

- Fusos devem ser reconhecidos pelo runtime, evitando falha de `Intl.DateTimeFormat` nas páginas e no motor de disponibilidade.
- Horários devem existir entre 00:00 e 23:59; abertura e fechamento devem ocorrer em ordem no mesmo dia. Expediente atravessando a meia-noite continua sem suporte.
- Somente dias da semana 0–6 são aceitos; dias de trabalho repetidos são rejeitados.
- Pausas devem respeitar o expediente. Início e fim iguais representam ausência de pausa, inclusive 00:00–00:00.
- Edição parcial é validada contra os horários já salvos e não grava outros campos quando a combinação é inválida.
- A gravação confere se o expediente validado ainda é o atual. Se outra edição o alterou, retorna conflito e exige atualização da página, evitando combinação inválida entre duas operações concorrentes.

### Vínculos do Superadmin

- Usuário deve existir e estar ativo antes de receber acesso a uma empresa.
- Papel de barbeiro exige profissional ativo da empresa selecionada; referências a outra empresa são recusadas sem substituir vínculos existentes.
- Ao trocar para gerente ou proprietário, o vínculo específico de profissional é limpo.
- E-mail é normalizado; referências são novamente conferidas no próprio comando de gravação.

### Último Superadmin

- Migração `0007_last_superadmin_guard.sql` bloqueia desativação, rebaixamento e exclusão da última conta Superadmin ativa no banco, inclusive em concorrência.
- As rotas retornam HTTP 409 com orientação para cadastrar ou reativar outro Superadmin.
- Operação recusada reverte a transação, preservando também senha, vínculos, sessões e códigos de recuperação.
- Anonimização permitida também elimina os códigos de recuperação da conta removida.
- **Esta proteção depende de aplicar a migração 0007 no banco de destino. Nesta rodada ela foi aplicada somente em banco local isolado.**

## Commits

| Commit | Alteração |
|---|---|
| `1aa8933` | Validação de fusos, horários e alterações parciais de expediente |
| `ab34889` | Isolamento e validação dos vínculos de acesso do Superadmin |
| `e5ed299` | Proteção transacional da última conta Superadmin ativa |
| `0165045` | Gravação condicional dos horários e isolamento entre arquivos de teste |

Este relatório e o checklist foram registrados em um commit adicional de documentação, consultável no histórico da branch.

## Verificações locais

- `npm run validate`: auditoria de dependências, 18 testes de configuração/CI, preparação e validação de configuração isolada, tipagem, build e suíte Workers/D1.
- Validação após os primeiros conjuntos: 142, 148 e 154 testes do sistema aprovados, respectivamente, além dos 18 de configuração/CI em cada execução.
- Teste de concorrência dos horários reproduziu a falha antes da correção: duas edições incompatíveis eram aceitas. A regressão passa após a gravação condicional.
- A suíte completa também expôs compartilhamento de estado entre arquivos com `isolate: false`. A configuração foi alterada para `isolate: true`, mantendo execução sequencial com um worker, para separar banco e módulos entre arquivos.
- Um erro de tipagem na fixture dos novos testes foi detectado pelo build e corrigido antes do envio do código correspondente.
- Migrações 0001–0007 aplicadas com sucesso via Wrangler em banco exclusivamente local e isolado (`--local` com diretório de persistência próprio).
- Resultado final: **155 testes Workers/D1 aprovados em 17 arquivos**, com isolamento completo entre arquivos. **18 testes de configuração/CI aprovados**, tipagem e build aprovados, auditoria sem vulnerabilidades.
- O último conjunto foi verificado pelos componentes locais (`npm test`, `npm run build` e `node --test scripts/staging-config.test.mjs scripts/ci-policy.test.mjs`). A última execução integral de `npm run validate` aprovada antes desse conjunto registrou 154 testes do sistema; a tentativa seguinte revelou a dependência de ordem descrita acima, corrigida com isolamento.
- A execução final dos testes isolados levou aproximadamente 94 segundos, sem consumo de minutos do GitHub Actions.

## Limites e pendências

- Nenhuma migração remota, publicação, operação financeira real ou envio real de mensagens foi realizado. Main, segredos, planos contratados e orçamentos não foram alterados. Nenhum outro projeto foi modificado.
- O workflow permanece apenas com `workflow_dispatch`, sem gatilhos automáticos. Habilitar o botão manual no GitHub depende de presença autorizada do workflow na branch padrão; main não foi alterada.
- A validação remota do novo HEAD pelo Actions não foi executada; a evidência desta rodada é local.
- Aplicar as migrações no banco correto e realizar testes end-to-end em homologação continuam pendentes de autorização e ambiente externo.
- Conferência visual da janela de senha provisória e validação das integrações Mercado Pago, WhatsApp, recuperação de acesso e processos de privacidade continuam pendentes antes do lançamento comercial.
- Nenhum serviço pago foi acionado nem recurso que gere gastos foi contratado ou ativado.
