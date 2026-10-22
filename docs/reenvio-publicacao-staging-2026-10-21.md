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
