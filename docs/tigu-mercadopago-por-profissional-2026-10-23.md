# TIGU — Separação dos recebimentos: plataforma, barbeiro e barbearia

Solicitação do proprietário em 23/10/2026: o MP já configurado na Cloudflare pertence exclusivamente ao TIGU plataforma e serve para assinaturas de planos e compra de créditos para mensagens. **Nunca** deve ser reutilizado para pagamentos de cortes e produtos.

Regra comercial:
- Corte: selecionar barbeiro, pagar agora ou depois; antecipação liquidada na conta MP do próprio barbeiro conectado.
- Produtos: proprietário escolhe recebedor do produto (barbearia ou barbeiro); checkout destina receita ao vendedor selecionado.
- Cada barbeiro autoriza sua própria conta na área **Meus recebimentos** do painel do profissional, sem token, senha ou configuração manual na Cloudflare pelo dono do TIGU.
- O estabelecimento conecta a própria conta no painel de administração para itens que lhe pertencem.
- Carteira de créditos e assinatura da plataforma permanecem isoladas da carteira dos vendedores.

Arquitetura necessária antes de ativar:
1. Criar aplicação OAuth/Marketplace do TIGU no Mercado Pago. **Uma única vez**: App ID (público), Client Secret (somente Worker de produção), HTTPS Redirect URL estática. Não é exigida configuração de Worker por profissional. O token já usado em MP_ACCESS_TOKEN para planos/créditos **não substitui** OAuth de vendedores.
2. Endpoint servidor de iniciar OAuth por profissional autenticado com tenant/barber_id, `state` aleatório de uso único, expiração curta, PKCE, CSRF, vinculados a sessão/empresa/usuário.
3. Callback global autorizado por Mercado Pago; troca do code apenas no servidor; validar proprietário da conta e evitar vinculação a barbeiro de outra empresa; tokens de acesso e refresh cifrados em D1 por conta e sujeitos a rotação, desconexão/revogação auditada.
4. Antes do Pix, derivar tenant, produto/serviço, barbeiro e recebedor do D1, não do corpo da requisição. Um pagamento só pode possuir um recebedor; carrinho de vendedores diferentes exige separar pedidos/pagamentos ou solução Marketplace oficialmente suportada.
5. Pix usa autorização do vendedor; webhook de pagamento assinado, consulta da API com token certo, conferência account/collector, idempotência, status pendente/aprovado/estornado, antifraude e conciliação; nunca ativar serviço apenas por redirect do navegador.
6. Homologar cada caso, inclusive refresh token, callback cancelado, usuário sem conta, sem saldo, pagamento duplicado, estorno e troca de recebedor com compras pendentes.
7. Staging não executa pagamentos reais. Produção isolada só receberá esta funcionalidade depois de migrations, secrets próprios, endpoint de OAuth e testes de homologação aprovados.

Mudança deste commit: painel de profissional exibe seção de recebimentos e consulta endpoint seguro **somente de status**; botão de conectar fica desabilitado até OAuth implementado/homologado. Nenhuma senha/token de vendedor é solicitado ou armazenado, e MP_ACCESS_TOKEN da plataforma não é compartilhado.

Não afirmar que o recebimento individual está operacional até todo o fluxo acima ser implementado e verificado.
