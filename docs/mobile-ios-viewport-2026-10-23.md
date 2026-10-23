# TIGU — Correção de zoom e largura no celular (23/10/2026)

O viewport já declarava `width=device-width, initial-scale=1.0`; não foi necessário bloquear zoom do usuário.

## Ajustes
- Inputs, selects e textareas do telefone utilizam fonte efetiva >= 16px para evitar ampliação automática ao focar no Safari iOS, inclusive formulários que não usam o componente compartilhado.
- `touch-action: manipulation` nos controles clicáveis evita zoom por duplo toque sem bloquear gesto de pinça e recursos de acessibilidade.
- Ajuste global da largura e do overflow em telas estreitas, conservando rolagem horizontal local de tabelas e coleções quando necessário.
- Cabeçalhos do site público e da página comercial se adaptam a nomes e telas estreitas.

## Evidência
- GitHub Actions PR 39977183865: `success`, com build, testes HTTP, Chromium e regressão de viewport de 320px, 390px e 430px.
- A suíte Chromium confere páginas comercial, login, contato, site público, agendamento e superadmin, verificando fontes de campos e largura da página.
- O teste Chromium não substitui verificação manual em Safari iOS real.
- Esta atualização de staging NÃO altera D1, R2, segredos, produção ou provedores de pagamento.

Após publicação no Worker de staging, testar especialmente os campos de login e checkout no Safari do iPhone.
