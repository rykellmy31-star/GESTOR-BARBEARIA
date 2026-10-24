# TIGU — autorização de migração exclusiva do D1 staging em 21/10/2026

O código na branch de auditoria em `546c6098d2e693ba6eed8e88344dbb4be732bfeb` passou no CI:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39675535950

Disparar exclusivamente o gate `TIGU_MIGRATE_BOOKING_STAGING_ONCE`, que verifica a identidade do Worker, D1 e R2 em homologação e executa migrações pendentes apenas no `tigu-staging-db`. A migração 0018 adiciona escolha de pagamento opcional e tabela financeira vinculada aos agendamentos. Backups anteriores já foram comprovados.

Não alterar `main`, produção ou R2, não criar recursos, não rodar cobrança real, não publicar o Worker neste commit.

A próxima publicação do Worker de homologação deverá usar o gatilho independente somente depois da migração bem-sucedida.
