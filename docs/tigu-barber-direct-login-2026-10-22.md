# TIGU — login do profissional entra diretamente no painel pessoal

Pedido do proprietário após observar o profissional entrando em `/selecionar`, escolhendo Barbearia Oceano, recebendo "não é dono/gerente" e só conseguindo alcançar a própria agenda posteriormente.

## Corrigido
- `api/routes/auth.ts`: destino de login de profissional com apenas uma empresa agora é `/c/:slug/painel`; dono/gerente continuam no `/admin`; superadmin continua em `/superadmin`.
- `src/pages/auth/CompanyPickerPage.tsx`: para uma única empresa ativa, envia diretamente para a rota por papel; se o usuário trabalha em várias, as escolhas de profissionais abrem `/painel` e as de gerente/dono abrem `/admin`. Botão de criar barbearia não aparece para usuário exclusivamente profissional.
- `src/pages/auth/LoginPage.tsx`: parâmetro next antigo apontando para `/admin` não força profissional para administração.
- `src/lib/hooks.ts`: `useCompanyRole` refaz o cálculo quando o caminho da barbearia muda; evita "Acesso negado" com contexto antigo depois de ir de `/selecionar` para `/c/:slug/painel`.
- Fluxo de troca obrigatória de senha existente preservado; após concluir a troca, profissional de uma empresa entra na sua própria agenda.

## Evidência
Teste unitário de roteamento para papeis owner/manager/barber e teste integrado Chromium verificando `next=/c/:slug/painel` em login real de profissional; testes totais passaram no GitHub Actions `39891222856` depois das correções de tipagem e contexto.

## Deploy autorizado
Gatilho exato `TIGU_UPDATE_WORKER_STAGING_ONCE`. Alterar SOMENTE código/assets de `tigu-staging`, preservar D1, R2, secrets, barbearias/usuários atuais, produção e pagamentos. Não aplicar migrations nem mudar domínio. Confirmar passo de deploy real no run do evento push, não apenas pull_request.
