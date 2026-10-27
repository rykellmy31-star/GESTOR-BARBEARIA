# TIGU — confirmação da assinatura do webhook Mercado Pago

## Estado conhecido
- O usuário confirmou a inclusão de `MP_MARKETPLACE_WEBHOOK_SECRET` nos secrets do GitHub.
- O conteúdo secreto não deve aparecer em logs, GitHub, chat ou arquivos.
- O domínio do projeto é `https://agendamentos.crjornada.com/`, atualmente direcionado ao **staging**, não à produção.
- O checkout dos serviços de cada profissional usa OAuth da conta dele; a plataforma possui webhook separado para seus próprios pagamentos.

## Endereços técnicos a configurar somente após publicação segura
- PUBLIC_URL da produção: `https://agendamentos.crjornada.com/` **quando** o domínio tiver sido migrado para o Worker `tigu-production`.
- Callback OAuth: `https://agendamentos.crjornada.com/api/oauth/mercadopago/callback`.
- Endpoint da plataforma: `https://agendamentos.crjornada.com/api/webhooks/mercadopago`.
- Endpoint por profissional: `https://agendamentos.crjornada.com/api/webhooks/seller-mercadopago/{companyId}/{barberId}` gerado pelo sistema ao criar o Pix.
- Não registrar callback de staging como retorno de OAuth de produção nem ativar eventos até verificação de assinatura e conciliação.

## Bloqueios que permanecem
- Publicar o Worker e aplicar migrações no D1 existente sem recriá-lo.
- Instalar segredos de produção adequados sem reutilizar chaves inseguras.
- Validar o provedor com o vendedor autenticado e um Pix de baixo valor, conferindo `collector_id`, webhook assinado e conciliação.
- Não habilitar `MERCHANT_PIX_ENABLED=1` enquanto houver bloqueio.

A execução desta alteração chama apenas o workflow **somente-leitura** que confirma presença dos nomes dos segredos e metadados do D1.
