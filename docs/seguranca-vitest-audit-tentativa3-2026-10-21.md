# Terceira execução de atualização do lockfile de segurança

A versão npm 10 do runner apresentou erro interno `Cannot read properties of null (reading 'edgesOut')` mesmo após `npm ci`. O workflow agora utiliza npm 11 no Node 22 para gerar um lockfile válido e atualizar apenas o Vitest para 4.1.12.

Bloqueios mantidos: `npm audit --audit-level=moderate` antes do commit; atualização limitada a `package.json` e `package-lock.json`, sem migração/deploy remoto e sem produção.
