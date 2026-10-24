# TIGU — resultado da homologação autenticada de 21/10/2026

- Atualização PBKDF2 isolada: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39669667150 (sucesso)
- Homologação de ponta a ponta: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39670087258 (sucesso)
- Resultado: **26 verificações HTTP autenticadas remotas**, duas barbearias fictícias.
- Confirmados: cadastro HTTP 201; sessões HttpOnly/Secure; isolamento entre tenants; plano gratuito; Pix externo bloqueado; configurações; barbeiro; serviço; agenda; criação, consulta e cancelamento de agendamento; produto; pedido; baixa e restauração de estoque; upload/download e bytes de imagem via R2.
- Restrições observadas: sem cobrança real e sem produção modificada.
- Ação de hardening: removida da API a instrumentação temporária `staging_diagnostic` e as etapas internas de signup. O teste agora reporta somente status e mensagem pública.
- Itens ainda não homologados: jornadas de superadministrador/gerente/barbeiro com usuários distintos, concorrência e remarcar, restauração do D1 com dados fictícios representativos, inventário integral R2 e integração com provedores reais.

Os números e o resultado referem-se a essa execução, não equivalem ao lançamento comercial completo.
