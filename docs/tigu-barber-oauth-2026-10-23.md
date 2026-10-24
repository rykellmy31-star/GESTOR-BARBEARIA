# TIGU Marketplace — OAuth por profissional (23/10/2026)

Solicitação do proprietário: cada barbeiro deve conectar seu Mercado Pago no próprio painel, sem cadastrar secrets individuais na Cloudflare, enquanto o token da plataforma permanece exclusivamente para mensalidades e créditos.

Implementação:
- `POST /api/c/:slug/barber/mercadopago/connect` protegido por sessão e membership `barber`, gera `state` aleatório de uso único (SHA-256 armazenado) e PKCE S256, com verifier criptografado.
- Callback global `GET /api/oauth/mercadopago/callback`, valida state + cookie HttpOnly/Secure/SameSite=Lax, expiração de 10 min, atomicamente consume o state, confere vínculo atual, troca o authorization code no Mercado Pago e criptografa access/refresh tokens por barbeiro no D1.
- Banco `migrations/0021_seller_mercadopago_oauth.sql`, isolamento por `(company_id,barber_id)`; sem modificar credenciais `MP_ACCESS_TOKEN` / `MP_WEBHOOK_SECRET`.
- Painel profissional possui botão **Conectar minha conta Mercado Pago**, que chama a própria rota e abre apenas `https://auth.mercadopago.com/authorization` para consentimento do barbeiro.
- O estágio de homologação `TIGU_STAGING=1` bloqueia a autorização em ambiente de teste com credenciais reais, mas mostra a seção informativa sem depender da nova migração; o checkout e Pix de prestadores continuam DESATIVADOS até reconciliação e webhooks por vendedor.
- Condições para ativação: Worker `tigu-production` isolado, novas tables migradas nele, `PUBLIC_URL`, `MP_MARKETPLACE_CLIENT_ID`, `MP_MARKETPLACE_CLIENT_SECRET`, `MP_MARKETPLACE_REDIRECT_URI`, `MSG_ENC_KEY` configurados no Worker de produção, testes com conta MP autorizada e webhook confiável. Não alterar DNS neste deploy.

Validação de código concluída: GitHub Actions `39897578713`, sucesso.

Gatilho deste commit: `TIGU_UPDATE_WORKER_STAGING_ONCE`, apenas publica UI e endpoints bloqueados em `tigu-staging`, sem alterar recursos produção, banco, dados, secrets ou migrar tabelas.
