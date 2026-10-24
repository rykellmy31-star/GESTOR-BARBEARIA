# TIGU — Manual operacional seguro (pré-lançamento)

> **Atenção:** este documento não autoriza publicar, editar o D1 comercial, gerar cobrança real ou restaurar backups de produção. O projeto permanece na branch `audit/tigu-primeira-validacao`, aguardando homologação e validação de cópias/restauração. Confirme sempre o ambiente e o ID do recurso antes de qualquer comando remoto.

## Rotina da barbearia

| Periodicidade | Operação |
| --- | --- |
| Todos os dias | Notificações e agenda: confirmar reservas pendentes, revisar cancelamentos, movimentar pedidos e conferir estoque |
| Feriados e férias | Agenda → Folgas: criar bloqueios para todos ou para um profissional |
| Mudanças de expediente | Barbeiros: revisar dias e horários, respeitando reservas futuras |
| Fechamento | Dashboard, relatórios, pedidos pagos/entregues, carteira e histórico de mensagens |

## Acessos e credenciais

- Recuperação de senha de funcionário **exclusivo de uma empresa**: painel → Equipe, ou Barbeiros → Senha do painel. A operação requer autorização e força troca de senha provisória no próximo login.
- Contas globais compartilhadas e Superadmin **não** podem ter senha alterada arbitrariamente pelo dono da barbearia. Use fluxo de recuperação verificado e suporte autorizado.
- Não use comandos SQL diretos para substituir senhas, papéis ou sessões em produção. Exemplos antigos de `UPDATE users WHERE role='admin'` são incorretos no esquema atual (o papel é separado entre `users.platform_role` e `company_memberships.role`).
- Segredos devem ficar em gerenciamento seguro do ambiente, nunca no Git ou em mensagens. Não confunda permissões de GitHub com autorização para alterações em Cloudflare.

## Backups D1 e R2: procedimento para homologação futura

1. Identificar claramente o D1 e o R2 de **origem**, os recursos de **destino isolado** e quem autoriza o teste. Verificar que o destino não é produção e não contém dados a preservar.
2. Exportar a base D1 autorizada para arquivo protegido, verificar integridade e registrar data/hash do artefato. O comando `wrangler d1 export` exige a configuração e o alvo corretos; não executar com nomes genéricos sem conferência.
3. Restaurar o arquivo **somente no D1 isolado de homologação**, aplicar as verificações de esquema, integridade, relações, contas, agendamentos, estoque e idempotência financeira. Nunca importar um backup por cima do D1 comercial para fazer um teste.
4. Copiar objetos do R2 para bucket separado com método autorizado, comparar listagem, quantidade, tamanhos e hashes dos arquivos. Uma cópia apenas do D1 **não** restaura fotos e anexos.
5. Ensaiar recuperação e retorno seguro: documentar RPO/RTO medidos, horário da última cópia, responsáveis, permissão de acesso, criptografia, retenção, alertas, custos e procedimento de rollback.
6. Aprovar registros de execução antes de classificar o sistema como recuperável. O teste automatizado local de restauração SQLite **não comprova** backup D1/R2 da conta Cloudflare.

Arquivos de documentação: [Homologação Staging](HOMOLOGACAO_STAGING.md), [Checklist 100%](CHECKLIST_100_POR_CENTO.md) e [Deploy](DEPLOY.md).

## LGPD e atendimento ao titular

- **Consulta:** Clientes → detalhe (histórico de agendamentos e pedidos), sempre sob permissão autenticada da empresa.
- **Anonimização:** Clientes → Anonimizar dados. O backend recusa a ação quando existem agendamentos ativos, pedidos abertos ou mensagens em envio/valores reservados; resolva-os antes de tentar novamente.
- **Efeitos técnicos:** remove contato do cadastro, reservas encerradas, pedidos, avaliações associadas e dados de entrega de mensagens; preserva identificadores sintéticos e os montantes necessários a histórico operacional/financeiro. A consulta pública antiga por telefone e protocolo deixa de recuperar a reserva anonimizada.
- **Limites:** uma ação técnica não substitui avaliação jurídica, regras de retenção e análise de outros registros legais/auditáveis. Antes de captar dados reais, os Termos/Política de Privacidade, a base legal e o procedimento de atendimento ao titular precisam de aprovação responsável.

## Segurança e operação

- Sessões HTTPS: cookies `HttpOnly`, `SameSite=Lax`, `Secure`; o servidor confere permissões por empresa em toda requisição protegida.
- O endpoint de leitura `GET /api/auth/me` não deve consumir o limite de **tentativas de autenticação**; operações de login e recuperação continuam limitadas.
- Aplicar migrações antes de publicar a versão correspondente, em ambiente autorizado, usando comandos de staging somente com configuração validada.
- Configurar monitoramento de respostas 5xx, falhas de WhatsApp, filas incertas, pagamento conciliado, conta suspensa e expiração de assinaturas, sem publicar dados pessoais nos logs.
- Pix, webhooks Meta, Turnstile, domínios, WAF e testes com provedores reais dependem de credenciais/contas externas, revisão de riscos e homologação autorizada. **CI local aprovado não confirma operação externa.**

## Situação de entrega

A versão candidata pode ter testes automatizados locais aprovados, mas isso não prova implantação nem recuperação de dados. Manter PR em rascunho, sem merge na `main`, até concluir homologação controlada, verificação D1/R2 e autorizações comerciais e legais necessárias.
