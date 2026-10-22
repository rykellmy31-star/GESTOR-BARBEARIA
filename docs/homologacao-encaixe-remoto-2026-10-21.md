# TIGU — homologação real de encaixes no staging

Worker `tigu-staging` atualizado e saudável:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697805090

Migração 0020 aplicada ao D1 `tigu-staging-db`:
https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39697427709

Gatilho exclusivo `TIGU_AUTH_STAGING_E2E_ONCE`: testes remotos com duas empresas fictícias, criação e cancelamento de reservas, encaixe de 15 minutos fora da grade, recusa de colisão 20 minutos com cliente das 10h, pedidos/estoque, mídia R2 e bloqueio de pagamento real.

A simulação exata de término antecipado às 9h45 é validada por testes locais de horário injetado; a API remota só permite registrar conclusão no instante real de atendimento (não aceita retroceder ou adiantar o relógio informado pelo cliente), portanto o ensaio remoto verifica a parte de encaixe com reservas fictícias futuras.

Sem produção, sem cobranças nem envio real de mensagens. As reservas usadas são canceladas no final do ensaio.
