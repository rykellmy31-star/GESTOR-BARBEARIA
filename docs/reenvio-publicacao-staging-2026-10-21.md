# TIGU — Reenvio de publicação de homologação

Solicitação expressa do proprietário para reenviar a atualização do site TIGU.

Escopo: Worker existente `tigu-staging`, banco D1 existente `tigu-staging-db`, R2 existente `tigu-staging-media`.

Alterações esperadas: reservas novas automaticamente confirmadas, ação "Não compareceu" em português, opção protegida de excluir barbearias de demonstração, página de status das integrações da plataforma.

Não publicar na produção, não recriar banco/bucket, não aplicar migrações, não trocar segredos.

Esta alteração é documentação e aciona o gatilho de atualização de staging. A confirmação depende do job de implantação terminar com sucesso.
