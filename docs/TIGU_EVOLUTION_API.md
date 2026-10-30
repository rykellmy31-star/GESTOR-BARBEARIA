# TIGU — Evolution API v2 (conexão QR por barbearia)

## Escopo
O TIGU removeu a integração Meta Cloud API e preserva Mercado Pago dos profissionais e a cobrança manual das mensalidades. A Evolution é o único provedor real de WhatsApp: cada barbearia tem instância isolada `tigu-company-<company_id>` e conecta seu próprio WhatsApp via QR Code no painel **WhatsApp & automações**.

Não precisa de n8n. A fila de mensagens já existente (confirmações e lembretes) continua agendando e enviando via Worker, respeitando opt-in, horário e plano. Para a Evolution, o preço por mensagem no TIGU é zero, sem reserva ou cobrança de créditos; mensagens antigas do provedor descontinuado não são reutilizadas na troca e permanecem somente para auditoria. A integração QR usa WhatsApp Web/Baileys **não oficial**: risco de desconexões/bloqueio do número e instabilidade dos formatos de mensagem. Nada é enviado sem conexão ativa.

## Dependências futuras para ativar
- Deploy isolado de Evolution API **v2**, com TLS e acesso de rede do Worker.
- Worker secrets (nunca no navegador ou git):
  - `EVOLUTION_API_URL`: origem HTTPS completa da instalação, ex.: `https://evolution.exemplo.com` (sem caminho).
  - `EVOLUTION_API_KEY`: chave de administração da Evolution, compartilhada pelo servidor TIGU, **nunca exposta ao proprietário**.
  - `EVOLUTION_WEBHOOK_SECRET`: segredo aleatório >= 32 caracteres para os callbacks.
  - `PUBLIC_URL`: origem HTTPS pública do TIGU, ex.: `https://agendamentos.crjornada.com`.
- Aplicar migração `migrations/0104_evolution_whatsapp.sql` no D1 apropriado antes de publicar código.
- Em staging `TIGU_STAGING=1`, criação/conexão/envio reais ficam bloqueados para evitar disparo a clientes.

## Sequência esperada
1. Proprietário acessa **Painel > WhatsApp** e escolhe Evolution API (QR Code).
2. TIGU cria somente a sua instância, registra callback autenticado e apresenta QR.
3. Proprietário lê o QR em **WhatsApp > Aparelhos conectados > Conectar aparelho**.
4. TIGU verifica `connectionState`, habilita os envios já previstos; se desconectar, os envios ficam retidos (não fingir envio).
5. Ao desconectar, TIGU encerra a sessão remota; não apaga o número WhatsApp.

## Cuidados
- URL e chave são exclusivamente globais em secrets Cloudflare; proprietário não informa endpoints arbitrários.
- Webhook valida header `x-tigu-webhook-token` e vincula a instância ao company_id para impedir vazamento entre barbearias.
- QR Code é temporário, pode expirar. A UI deve permitir gerar outro.
- Respostas recebidas são registradas/avisadas, mas **não cancelam nem confirmam horários automaticamente** até existir fluxo explícito e seguro de intenção/consentimento.
- **Não fazer merge/deploy** antes de testes em staging, verificação de permissões, migrações e homologação com número controlado.

## Verificação de publicação oficial
A implementação da Evolution API foi incorporada à branch de preparação do TIGU. O diagnóstico de D1 permanece bloqueado até o histórico de migrações existentes ser reconciliado sem alterações destrutivas. Antes de qualquer publicação no domínio agendamentos.crjornada.com, o GitHub Actions precisa confirmar o vínculo com o Worker tigu-staging e os recursos D1/R2 já existentes, bem como a aplicação segura das migrações aditivas 0103 e 0104. O servidor Evolution API não foi instalado e o modo TIGU_STAGING=1 não permite conectar números reais.

A publicação oficial permanece condicionada ao backup validado, histórico D1 e testes sem regressões.

## Gatilho de publicação controlada
A publicação no domínio oficial só poderá prosseguir se os testes completos aprovarem e o D1 existente tiver exportação SQL verificada em SQLite temporário; caso contrário, o GitHub Actions bloqueia o deploy. Nenhum segredo será escrito no repositório, e o modo de homologação da conexão WhatsApp será preservado.

**Publicação controlada:** o envio do código Evolution-only ao Worker oficial é protegido por validação completa, backup verificado e preservação do D1/R2 e dos segredos existentes. Não habilita o servidor externo Evolution automaticamente.

A versão Evolution-only substitui os endpoints e formulários Meta sem executar migrações adicionais no D1 já homologado.

Atualização visual: os avisos de risco não são exibidos no painel. A carteira de créditos e as telas de recarga/precificação foram retiradas da navegação do TIGU, preservando o histórico financeiro no D1 para auditoria e conciliações.

## Publicação direta no domínio oficial — 30/10/2026

O Worker **existente** `tigu-staging` responde pelo domínio oficial `https://agendamentos.crjornada.com`, apesar do nome histórico. Não criar outro Worker, banco D1 ou ambiente de testes. A publicação do painel QR e do cron de mensagens Evolution é independente dos pagamentos: `TIGU_STAGING=1` e `PAYMENTS_MOCK=0` permanecem, inclusive o bloqueio de fluxos financeiros de homologação. A flag exclusiva `TIGU_EVOLUTION_LIVE=1` permite apenas a conexão e os webhooks da Evolution real. O cron despacha **somente** jobs `provider='evolution'`; não processa filas legadas Meta ou mock.

O script de deploy mantém os segredos existentes e adiciona `EVOLUTION_API_URL=https://evolution.crjornada.com`, `PUBLIC_URL=https://agendamentos.crjornada.com`, `TIGU_EVOLUTION_LIVE=1`, além de um cron `* * * * *`. Não registra chaves no GitHub. Para ativar realmente o QR, o operador da plataforma precisa cadastrar **somente no Worker** dois segredos: `EVOLUTION_API_KEY` (chave global da instalação Evolution; nunca chave por instância) e `EVOLUTION_WEBHOOK_SECRET` (segredo aleatório exclusivo de ao menos 32 caracteres). Após salvar esses segredos, o painel de cada barbearia gera automaticamente sua instância e QR; o proprietário não precisa inserir URLs ou chaves.

A ativação não é comprovada apenas pelo deploy: conferir `/api/health` (WhatsApp configured=true), realizar login do proprietário, criar instância e escanear QR com número controlado e enviar mensagem de teste antes do primeiro agendamento com cliente. Não reenvia automaticamente mensagens antigas.

## Diagnóstico de QR bloqueado com segredos já cadastrados — 30/10/2026

A indicação "servidor Evolution API ainda será configurado" é controlada por `evolutionLiveAllowed` no Worker. A presença do **nome** de um segredo no painel Cloudflare não confirma que ele está ativo no deploy ou que atende aos requisitos. `EVOLUTION_WEBHOOK_SECRET` precisa ter **pelo menos 32 caracteres**, não pode ser vazio, e `EVOLUTION_API_KEY` precisa ter valor não vazio. O Worker oficial deve conter `EVOLUTION_API_URL`, `PUBLIC_URL` (HTTPS, sem caminhos) e `TIGU_EVOLUTION_LIVE=1`.

O painel autenticado **WhatsApp → Evolution API** agora recebe em `/admin/whatsapp/evolution/status` somente o **motivo seguro** do bloqueio: nome da variável faltante, webhook curto, URL inválida ou modo Evolution desabilitado. Nunca exibe valor de chave, token, URL ou senha. Os administradores das barbearias não podem editar os bindings da plataforma.

Se os segredos estiverem listados, verificar se foram salvos e **implantados no Worker `tigu-staging` que responde por `agendamentos.crjornada.com`**; não recriar Worker nem banco. Se houver mudança de segredo, usar **Deploy** na Cloudflare e depois atualizar a página do proprietário. O TIGU nunca substitui a chave por texto enviado do frontend.

Após `configured=true`, cada barbearia administra apenas a sua instância `tigu-company-<id>`. Quando desconectada, pode usar **Gerar / atualizar QR** para escanear novamente no WhatsApp, sem retornar à Cloudflare. O recurso não interfere nos pagamentos dos profissionais, bancos, reservas ou histórico de mensagens.

Diagnóstico autenticado habilitado para a versão oficial: não modifica D1, R2, segredos nem permissões de conexão.
