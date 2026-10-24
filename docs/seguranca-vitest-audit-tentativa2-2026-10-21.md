# Segunda tentativa de atualização de segurança Vitest

21/10/2026. A primeira tentativa de npm install em GitHub Actions falhou por erro interno do npm (null edgesOut), sem alterar dependências nem o Worker: https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39677336018.

O workflow passou a executar `npm ci` sobre o lock existente antes da atualização para Vitest 4.1.12, depois `npm audit --audit-level=moderate`, e só após sucesso fará commit com package.json e package-lock.json.

Operações estritamente de código, na branch de auditoria. Sem Cloudflare e sem merge.
