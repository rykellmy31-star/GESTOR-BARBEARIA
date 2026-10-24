# Tigu — cadastro, reset e reativação de equipe

Data: 19/10/2026. Branch: `audit/tigu-primeira-validacao`.
Base: `93abc2327253cd5b052472e5e3fb3ef42ab9dd63`.

## Alterações

### Cadastro transacional

A criação por `/admin/team` e `/admin/barbers/:id/credentials` agora grava conta e vínculo em uma transação D1. O aviso de boas-vindas, quando utilizado, participa da mesma transação. Falhas no vínculo ou no aviso revertem a conta, permitindo repetir a operação sem deixar o e-mail ocupado por cadastro parcial.

O write confere empresa ativa e profissional ativo da mesma empresa. Cadastros concorrentes do mesmo e-mail produzem uma conta, um vínculo e um aviso; o perdedor recebe conflito. Conta global existente não é vinculada nem tem senha substituída por conhecimento do e-mail. Os novos acessos continuam exigindo troca de senha.

Não foi executada limpeza de dados legados ou remotos. A prevenção vale para os novos cadastros que utilizarem esta versão.

### Reset e edição com estado atual

A edição de equipe compara papel, profissional e estado do vínculo antes de gravar. Reset confere novamente o hash da senha, conta ativa, papel global comum e ausência de vínculos em outra empresa dentro da transação. Se a conta for promovida a Superadmin ou vinculada a outra barbearia entre a leitura e a gravação, o reset é recusado sem revogar sessões/códigos.

Remoção não sobrescreve promoção concorrente para dono. Reset, revogação de sessões e invalidação de códigos são transacionais. Falha em qualquer etapa reverte as alterações. Cada reset da rota gera um hash com salt novo para identificar a credencial desta operação.

### Reativação e painel

`active: true` passa a reativar o vínculo efetivamente, conferindo conta global e profissional ativo quando o acesso é de barbeiro. Não remove restrição de troca obrigatória de senha nem ativa conta global suspensa. O papel de dono continua protegido.

Na tela **Equipe & acessos**:

- integrante inativo recebe botão **reativar acesso**;
- ações ficam desabilitadas enquanto uma remoção/reativação está em andamento;
- falha ao consultar equipe mostra mensagem e opção de tentar novamente;
- seleção de profissional mostra apenas ativos;
- cadastro concluído limpa os campos, incluindo senha provisória;
- orientação para e-mail já cadastrado direciona ao suporte, de acordo com a regra do servidor.

A interface foi compilada; a aparência ainda não foi inspecionada em navegador funcional.

## Commits de implementação

| Commit | Alteração |
|---|---|
| `0241aaf309e30696f89fbf0d32e495a590fbd0de` | Cadastro de conta, vínculo e aviso em transação única |
| `28e120de2e9a5e2b82511d6e6dd6ba10fb3b1b56` | Permissões revalidadas, reset transacional, reativação e painel |

Relatório, guia e checklist registrados em commit adicional de documentação.

## Testes realmente executados

- `npm run validate` após cadastro transacional: 222 testes em 27 arquivos, 21 testes de scripts/configuração, tipagem e build aprovados; auditoria com zero vulnerabilidades.
- `npx vitest run tests/team-access-race.test.ts tests/team-account-isolation.test.ts`: 14 testes aprovados; `npm run check:types` aprovado.
- `npm run validate` final: **231 testes em 28 arquivos + 21 testes de scripts/configuração**, tipagem e build aprovados; auditoria de dependências com zero vulnerabilidades.
- `node scripts/local-e2e.mjs`, após o build atualizado: **34 verificações HTTP aprovadas**, incluindo cadastro de equipe, senha provisória, troca obrigatória, remoção, reativação e reset, além dos fluxos anteriores de agenda, estoque, quinze dias grátis, vencimento, Superadmin, uploads e isolamento.
- Banco temporário novo com migrações 0001–0010; Worker e R2 somente locais. Processo encerrado e persistência temporária removida.
- Novos testes forçam mudança de estado antes do commit e falhas de vínculo/notificação/reset para comprovar reversão no D1.

## Pendências e limites

- Conferir visualmente as telas e o novo botão em navegador funcional.
- Homologar Cloudflare/HTTPS, integrações e webhooks externos com acesso autorizado e condições gratuitas confirmadas.
- Aplicar migrações remotas pendentes somente no banco correto, após autorização e preparação de backup/rollback.
- Concluir termos, privacidade, suporte, recuperação de acesso e rotinas operacionais antes de liberar clientes reais.
- Integração à main e publicação em produção continuam dependendo de autorização explícita.

Nenhuma main, segredo, orçamento ou outro projeto foi alterado. Nenhum serviço pago, deploy, migração remota, pagamento real ou envio real de WhatsApp foi executado. Workflow permanece manual e commits utilizam `[skip ci]`. A suíte local não comprova homologação visual ou externa; o projeto ainda não deve ser declarado 100% pronto para produção.
