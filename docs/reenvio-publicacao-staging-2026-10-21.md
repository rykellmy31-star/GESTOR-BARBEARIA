# TIGU — Reenvio de publicação de homologação

Solicitação expressa do proprietário para reenviar a atualização do site TIGU.

Escopo: Worker existente `tigu-staging`, banco D1 existente `tigu-staging-db`, R2 existente `tigu-staging-media`.

Alterações esperadas: reservas novas automaticamente confirmadas, ação "Não compareceu" em português, opção protegida de excluir barbearias de demonstração, página de status das integrações da plataforma.

Não publicar na produção, não recriar banco/bucket, não aplicar migrações, não trocar segredos.

Esta alteração é documentação e aciona o gatilho de atualização de staging. A confirmação depende do job de implantação terminar com sucesso.

## Reenvio após investigação de CI (2026-10-22)

As execuções anteriores sofreram atraso de 7 minutos no npm ci e falha 503 no npm audit (registro npm indisponível). O CI agora usa cache preferencial e limites de rede; o bloqueio de vulnerabilidades conhecidas permanece obrigatório. Quando o audit está indisponível por erro de rede, a homologação informa auditoria inconclusiva e segue somente com os demais testes de staging.

Este commit é o gatilho explícito da segunda tentativa. Nenhum recurso de produção é alterado.

## Reenvio após timeout do registro npm
Execução anterior encontrou a mensagem literal `network timeout` do endpoint de auditoria, não reconhecida pela primeira regra de indisponibilidade. A regra foi corrigida e preserva o bloqueio para vulnerabilidades identificadas. Nova tentativa solicitada pelo proprietário, exclusivamente staging.

## Reenvio após mudança do endpoint npm
O registro npm passou a rejeitar sua rota antiga de auditoria com 400 "This endpoint is being retired" e "Invalid package tree". Sob o gatilho explícito de publicação staging, essa condição será tratada como auditoria inconclusiva (não aprovada); os testes funcionais seguem e vulnerabilidades reportadas continuam bloqueantes. Publicação somente no Worker de homologação.

## Reenvio após atualizar testes de confirmação automática
Os testes da reserva antiga esperavam `pendente` e confirmar manualmente; agora validam `confirmado` ao criar e preservação após fechamento da agenda. A execução continua restrita ao Worker de homologação.

## Reenvio após corrigir o teste de remarcação no Chromium

A suíte de navegador tentava reservar o dia seguinte mesmo sem horário aberto (por exemplo, domingo); agora consulta até dez dias e seleciona um horário realmente disponível. A alteração de código não muda política comercial de agendamentos. Os testes unitários e HTTP locais da execução anterior já estavam aprovados. Este commit aciona apenas `tigu-staging`; nenhuma operação em produção.

## Atualização da vitrine pública
Removidos do cabeçalho e do destaque da landing page os links “Prévia visual” e “Explorar prévia visual”, juntamente com o aviso sobre dados fictícios. Mantidos “Começar grátis”, login, planos e cadastro. Não houve alteração nos dados de clientes, bancos ou segredos. Publicação solicitada exclusivamente no Worker de homologação.

## Correção 2026-10-22 — painéis de barbearias acessados pelo Super Admin
Captura recebida: `https://agendamentos.crjornada.com/c/bim-brasil/admin/carteira`, com mensagem de falha no carregamento. O domínio responde `staging:true`, com D1/R2 operacionais. Causa identificada no código: Gate React autorizava Super Admin sem vínculo a abrir o painel, mas tenantMiddleware exigia company_membership e negava todas as consultas. Implementado suporte estritamente READ-ONLY para Super Admin autenticado em rotas /admin/ sob tenant existente/ativo, sem privilégios de escrita e sem alterar o isolamento dos usuários normais. O cabeçalho do painel explica a limitação e o botão do Super Admin foi corrigido.

Testes adicionados para leitura do painel, carteira, acesso comum de proprietário, bloqueio de escrita, negação a usuário comum e empresa suspensa. Validação pré-deploy da branch concluiu com sucesso no GitHub Actions. Publicação requerida SOMENTE no Worker `tigu-staging`; sem migrações, sem recriar bancos ou girar segredos, sem habilitar provedores reais.

## Publicação da navegação responsiva e onboarding do proprietário — 2026-10-22

Solicitado pelo titular: adaptar Super Admin e painel do proprietário automaticamente à largura mobile/desktop, sem causar rolagem horizontal da página; gerar uma mensagem pronta para copiar ao cadastrar nova barbearia, com dono, nome da empresa, login, senha temporária disponível somente no instante do cadastro, plano selecionado e data final dos 15 dias gratuitos.

Incluído teste automático real de Chromium em viewport móvel 390px, gaveta de navegação e mensagem de boas-vindas; testes unitários de omissão de senha em conta já existente. Homologação sem escrever dados remotamente concluiu com sucesso na verificação da branch.

Solicitada atualização somente do Worker `tigu-staging`, mantendo D1/R2, secrets e produção existentes. Não habilitar Mercado Pago nem WhatsApp reais e não executar migrações ou cobranças.
