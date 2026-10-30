# WhatsApp do TIGU — Evolution API v2

A **única integração externa de WhatsApp** do TIGU é a Evolution API v2, com uma sessão isolada por barbearia. Os endpoints de Graph API, WABA, Embedded Signup e webhooks da Meta não fazem parte da versão atual.

## Conexão
O proprietário abre **Painel da barbearia → WhatsApp → Evolution API**, inicia a conexão e escaneia o QR Code em *WhatsApp → Aparelhos conectados*. O servidor Evolution deve estar instalado em HTTPS e ser acessível pelo Worker.

## Configuração Cloudflare
Segredos do Worker:
- `EVOLUTION_API_URL`: origem HTTPS do servidor Evolution.
- `EVOLUTION_API_KEY`: chave global protegida somente no servidor.
- `EVOLUTION_WEBHOOK_SECRET`: segredo aleatório de pelo menos 32 caracteres para callbacks.
- `PUBLIC_URL`: origem HTTPS do TIGU, `https://agendamentos.crjornada.com`.

Callback: `POST /api/webhooks/evolution/`, com cabeçalho privado `x-tigu-webhook-token`.

Cada empresa usa instância `tigu-company-<id>` e isolamento por `company_id`. Os textos de confirmação e lembrete são editáveis no TIGU, respeitam consentimento do cliente e limite do plano. O preço de mensagem Evolution no TIGU é **R$ 0,00**; hospedagem externa pode ter custos.

## Histórico e segurança
As tabelas `whatsapp_connections` e `message_jobs` com dados de provedores anteriores permanecem intactas para auditoria. A conexão antiga não pode enviar, autenticar ou receber webhooks. Jobs antigos não são enviados por outro provedor e reservas pendentes são liberadas pela fila de segurança. Não remova tabelas ou segredos históricos sem um processo separado de retenção LGPD e backup.

## Avisos importantes
- Evolution via Baileys/WhatsApp Web é **não oficial**, com risco de desconexão ou suspensão do número.
- Com `TIGU_STAGING=1` o envio real é bloqueado por segurança.
- Sem servidor Evolution e credenciais, o QR Code é exibido como indisponível e nenhuma mensagem real será enviada.
- A integração não lê respostas para confirmar ou cancelar agendamentos automaticamente.
