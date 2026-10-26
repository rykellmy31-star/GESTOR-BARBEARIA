# TIGU — token de produção

Esta execução utiliza **somente leitura** de metadados Cloudflare (GET). Não executa deploy, migração nem gera Pix. Registra presença do Worker tigu-production, D1 e R2, além do resultado da autorização de leitura. O valor do token permanece como segredo criptografado do GitHub Actions.

A confirmação deste inventário não significa que existam segredos Mercado Pago instalados no Worker nem que as permissões de escrita estejam corretas.

O próximo passo, após identificar a infraestrutura, será preparar implantação com pagamentos **desligados**, validando migrações, recursos e OAuth antes de ativar Pix real.
