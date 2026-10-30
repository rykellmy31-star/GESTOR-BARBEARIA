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
