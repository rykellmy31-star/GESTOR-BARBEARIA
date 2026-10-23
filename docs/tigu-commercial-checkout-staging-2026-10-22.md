# TIGU — apresentação comercial do checkout direto e preparação da produção

O titular solicitou acrescentar "Adquirir plano" ao lado/abaixo de "Solicitar atendimento comercial" nas opções Pro e Scale. No fluxo final, pagamento aprovado deve preceder criação da barbearia e definição de login/senha. O Start preserva seus 15 dias de teste grátis.

Implementado:
- Em `SalesPlansSection.tsx`, botão "Adquirir plano" nos planos pagos, preservando o atendimento comercial;
- Nova rota `/adquirir?plano=pro|scale`, com preços lidos da API, indicação de plano, visualização das etapas do checkout e alternativa de atendimento;
- A cobrança é deliberadamente **indisponível** até a homologação da integração Pix com cliente sem tenant, persistência de intenção de pagamento, callback do Mercado Pago validado, idempotência, e criação segura de conta só após aprovação;
- Não coletar senha antes de confirmar o pagamento e não permitir geração de QR Code fictício;
- Sem alteração nos fluxos de assinatura já existentes das empresas.

Infra de produção já criada no evento `39886959367`: D1 `tigu-production-db`, R2 `tigu-production-media`, sem Worker, sem migrações e sem DNS.
325 testes Vitest e 50 verificações Chromium aprovados nesse mesmo evento.

Gatilho exclusivo `TIGU_UPDATE_WORKER_STAGING_ONCE`: **somente** atualizar o código do Worker `tigu-staging`, preservando secrets, banco, bucket e dados. Não habilitar provedores reais nem modificar produção. Objetivo da publicação: revisão visual do botão e do fluxo bloqueado com segurança.
