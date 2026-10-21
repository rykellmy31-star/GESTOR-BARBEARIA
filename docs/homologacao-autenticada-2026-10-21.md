# TIGU — ciclo de homologação remota autenticada

Data: 21 de outubro de 2026.

O deploy da correção PBKDF2 ao Worker isolado `tigu-staging` foi aprovado pelo GitHub Actions:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39669667150

## Escopo desta execução

Acionar exclusivamente `scripts/staging-auth-e2e.mjs` na branch `audit/tigu-primeira-validacao` por mensagem exata de commit.

- Criar duas barbearias com emails em `example.test` e credenciais aleatórias fictícias.
- Validar cadastro, autenticação, cookies, isolamento de tenants, profissional, serviço, agendamento, pedido/estoque e mídia R2.
- Nunca habilitar pagamentos ou mensagens reais, não tocar na produção.
- Não repetir os ensaios de restauração D1/R2, pois os destinos existentes devem ser preservados.
- Registrar o resultado real do workflow; não assumir aprovação por ter ocorrido deploy bem-sucedido.
