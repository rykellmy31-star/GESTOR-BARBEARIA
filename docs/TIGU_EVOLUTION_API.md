# TIGU — Evolution API v2 (conexão QR por barbearia)

## Escopo
O TIGU mantém integralmente a integração Meta Cloud API, Mercado Pago de profissionais e as mensalidades manuais da plataforma. A Evolution é uma opção adicional: cada barbearia tem instância isolada `tigu-company-<company_id>` e conecta seu próprio WhatsApp via QR Code no painel **WhatsApp & automações**.

Não precisa de n8n. A fila de mensagens já existente (confirmações e lembretes) continua agendando e enviando via Worker, respeitando opt-in, horário e plano. Para a Evolution, o preço por mensagem no TIGU é zero, sem reserva ou cobrança de créditos; mensagens antigas de outros provedores não devem ser reutilizadas na troca. A integração QR usa WhatsApp Web/Baileys **não oficial**: risco de desconexões/bloqueio do número e instabilidade dos formatos de mensagem. Nada é enviado sem conexão ativa.

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
