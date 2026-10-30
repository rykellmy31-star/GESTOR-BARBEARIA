# TIGU — Publicação direta da Evolution API no domínio oficial

Esta mudança libera exclusivamente a integração QR Code e a fila Evolution no Worker existente ligado a `https://agendamentos.crjornada.com`.

- Sem publicação em outro ambiente.
- Sem substituição de D1/R2, DNS ou segredos existentes.
- Preserva `TIGU_STAGING=1` para fluxos financeiros e homologações antigas.
- Instância independente por barbearia; QR Code gerado no próprio painel.
- Cron de um minuto restringido ao provedor `evolution`.
- Secrets `EVOLUTION_API_KEY` (chave global) e `EVOLUTION_WEBHOOK_SECRET` precisam estar cadastrados no Worker para conexão real; nenhum token entra no repositório.
- Publicação bloqueada automaticamente se backup, inventário e verificações não passarem.
