# TIGU — nova verificação somente leitura do D1 staging, 21/10/2026

A homologação anterior aprovou 33 testes HTTP autenticados, CI e Worker atualizado. Este gatilho verifica novamente o banco `tigu-staging-db`, incluindo a migração 0019 de recebimentos por barbearia, usando exportação SQL remota de leitura e restauração EFÊMERA local para teste de integridade, referências e tabelas. Não exportar o dump como artefato.

Não restaurar no D1 existente, não recriar recursos nem habilitar Mercado Pago real. O ensaio remoto de recuperação para D1/R2 deve esperar destinos isolados disponíveis e autorização de eventuais custos.
