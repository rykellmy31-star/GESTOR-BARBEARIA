# TIGU — não exibir layout de demonstração durante carregamento

Pedido do proprietário a partir do site AURUM: em carregamento/reload, não exibir nome, imagem, horários ou texto fictício padrão que depois são substituídos pelas configurações reais salvas.

## Correções
- PublicLayout bloqueia renderização do site e navegação durante a busca do `/api/c/:slug/config`, exibindo apenas fundo neutro e estado acessível de carregamento;
- Se a configuração falhar, exibe erro neutro e ação de tentar novamente, sem renderizar dados de outra barbearia;
- HomePage remove fallback `Aurum`, imagem de hero `/img/hero.jpg`, descrição fixa do projeto e horários fictícios;
- Após dados carregados, hero usa `shop_name`, `tagline`, `about` e `banner_url` salvos no banco, sem alterar dados de tenant;
- Teste Chromium verifica identidade da barbearia criada e ausência de `AURUM` no DOM.

## Deploy desta execução
Gatilho **`TIGU_UPDATE_WORKER_STAGING_ONCE`**: somente atualizar código e assets de `tigu-staging` preservando bindings, secrets, D1, R2, usuários e domínio atual. Não migrar, não criar recursos, não afetar produção e não habilitar gateways de pagamento/Meta reais.

Teste anterior do commit de alteração foi aprovado no GitHub Actions `39888514349`, com testes de navegador e API.

O usuário deve poder testar visualmente o site da barbearia e verificar que o conteúdo anterior não pisca ao atualizar.
