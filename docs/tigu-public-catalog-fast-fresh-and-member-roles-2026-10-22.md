# TIGU — catálogo imediato e rótulos de vínculo no Super Admin

Solicitação: produtos, serviços e profissionais já cadastrados devem aparecer no site público imediatamente, sem esperar minutos; lista de usuários do Super Admin deve distinguir papel de dono, gerente e profissional, em vez de exibir genericamente "user".

## Correções implementadas
- HomePage: o hook de revelação observa novamente os cards depois que as chamadas assíncronas ao banco retornam; produtos/serviços/barbeiros deixam de ficar invisíveis por falta da classe de animação `in`.
- Consultas públicas de catálogo: `staleTime:0`, atualização ao abrir, ao voltar para a aba e polling de 5 segundos enquanto a aba está em primeiro plano; reviews com intervalo de 60 segundos. API já responde com `Cache-Control: no-store`.
- Edições de serviços/produtos/profissionais no painel já invalidavam os caches do próprio navegador, mecanismo preservado.
- `GET /api/super/users` retorna `membership_roles` derivados de `company_memberships`, sem mudar `platform_role`, RBAC, ou criar colunas no D1.
- Lista Super Admin distingue `Super Admin`, `Dono`, `Gerente`, `Profissional` e `Sem vínculo` a partir dos relacionamentos reais.
- Usuários ligados a múltiplas empresas exibem seu papel prioritário sem converter automaticamente as permissões.

## Homologação e publicação
Bateria CI aprovada no GitHub Actions `39892638644` incluindo testes de navegador. Gatilho exato deste commit: `TIGU_UPDATE_WORKER_STAGING_ONCE` para publicar APENAS no Worker `tigu-staging`, preservar D1, R2, credenciais, contas e domínio atual; sem migrações e sem ativar PIX ou mensagens reais.

**Observação:** atualização periódica reduz atrasos de dados em clientes já conectados; o navegador pode suspender polling em abas ocultas. Não se deve afirmar tempo máximo de 5 segundos em qualquer condição de rede. A paginação/otimização futura poderá usar push/invalidação por evento.
