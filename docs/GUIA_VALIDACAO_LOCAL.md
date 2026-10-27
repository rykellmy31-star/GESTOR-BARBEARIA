# Validar Tigu sem consumir GitHub Actions

Execute na cópia do repositório, na branch `audit/tigu-primeira-validacao`, com Node >=22.12:

```bash
npm ci
npm run validate
npm run test:local-e2e
```

`validate` confere dependências, scripts, configuração isolada de homologação, tipagem, build e testes Workers/D1. Não publica nem migra bancos remotos.

`test:local-e2e` faz um novo build e inicia um Worker apenas em `127.0.0.1`, com D1, R2 e configuração temporários. Aplica todas as migrações, gera contas fictícias e verifica via HTTP:

- cadastro e sessão, isolamento entre duas barbearias;
- teste gratuito de quinze dias e bloqueio após vencimento, com consulta e cancelamento público preservados;
- criação de profissional e serviço, disponibilidade, reserva, remarcação e cancelamento;
- criação de produto, pedido, reserva de estoque e devolução no cancelamento;
- login do Superadmin, cadastro assistido e proteção da última conta administrativa;
- cadastro de equipe, troca obrigatória de senha, remoção, reativação e reset de acesso;
- indisponibilidade de Pix real durante todo o teste;
- upload de foto pelo R2 local, recusa de formato falso, proteção de cache da API e política de referrer da página.

O processo encerra o Worker e remove seus dados temporários ao terminar. Não cria recursos na Cloudflare nem utiliza o banco de desenvolvimento habitual. As credenciais geradas pertencem somente ao teste e não são exibidas.

O comando não aceita URL ou argumentos adicionais. Não há `--remote`, deploy ou execução de cron. As integrações reais ficam bloqueadas. Não adicione credenciais reais para executá-lo.

## Limites da evidência

Este teste usa o build real e o Worker via HTTP, mas não abre navegador nem confirma a aparência das telas. Homologação visual, domínios, cookies em HTTPS, credenciais e webhooks externos exigem validação separada antes do lançamento.

O workflow da branch só aceita `workflow_dispatch`; nenhum destes comandos aciona o GitHub Actions. A presença do botão manual no GitHub depende de integração autorizada do workflow na branch padrão.
