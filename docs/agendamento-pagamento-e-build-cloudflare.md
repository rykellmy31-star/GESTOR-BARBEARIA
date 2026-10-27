# TIGU: pagamento opcional de agendamentos e correção do build Cloudflare

**Fluxo:** no último passo do agendamento, oferecer pagamento após o serviço ou Pix antecipado. A plataforma fixa o valor ao preço do serviço no D1 e não confia em quantias enviadas pelo navegador. Uma reserva paga e posteriormente cancelada deve solicitar estorno/conciliação assistida; pagamento não deve ser confundido com status de atendimento.

**Ativação Pix:** é necessário decidir e autorizar se a conta do Mercado Pago recebedora será da plataforma ou de cada barbearia (e respectivos repasses, taxas e política de estornos). Não habilitar pagamentos reais automaticamente, nem em staging. Somente marcar como pago após reconfirmar ID, valor, referência, moeda e método pela API do gateway.

**Migração:** aplicar 0018_booking_checkout.sql exclusivamente no banco correto antes de publicar código que dependa de booking_payments. Não sobrescrever D1/R2 existentes.

**Erro do Cloudflare Workers Builds (21/10/2026):** o painel executou somente npx wrangler deploy, enquanto o projeto necessita gerar dist com Vite. Em Workers & Pages > Worker criado > Settings > Build, configurar Build command: npm ci && npm run build; Deploy command: npx wrangler deploy; Root directory: raiz do repositório. Antes de autorizar a publicação, verificar branch e bindings corretos. Workers Builds ignora build.command do wrangler.jsonc, portanto é essencial ajustar as opções do projeto Cloudflare. O script npm run deploy existente também executa preflight de produção, mas não deve ser acionado por engano em homologação.
