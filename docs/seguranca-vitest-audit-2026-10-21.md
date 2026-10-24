# Correção de segurança das dependências de testes

O GitHub Actions apontou advisories moderados no Vitest 4.1.11, anteriormente aprovado, na execução https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39676990378.

Este commit aciona uma única atualização auditável de `package.json` e `package-lock.json` para o Vitest 4.1.12, via `npm install --save-dev --save-exact` executado no runner oficial GitHub. O workflow exige novo `npm audit --audit-level=moderate` aprovado antes de registrar o commit de atualização.

O comando não executa migração nem deploy, não lê nem altera secrets e não toca em produção ou na branch `main`.
