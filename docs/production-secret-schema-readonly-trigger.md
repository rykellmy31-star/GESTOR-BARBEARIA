# TIGU — Inspeção sem escrita

O GitHub Actions vai verificar somente **presença dos nomes das credenciais no GitHub** e executar **SELECT somente leitura** da lista de tabelas do banco `tigu-production-db`. Não exibe valores de segredos nem IDs, não aplica migrações, não cria Worker, não troca DNS, não gera Pix.

A presença dos segredos no GitHub não comprova que o Mercado Pago os aceite. A integração real depende de OAuth do profissional, webhook assinado, deploy com chaves separadas e pagamento piloto real.
