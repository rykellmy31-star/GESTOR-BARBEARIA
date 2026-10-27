# TIGU — inspeção de destinos de recuperação D1/R2

Execução única e somente leitura: verificar identidade do Worker, D1 e bucket de staging e consultar via GET se `tigu-staging-restore-check` já existe como banco D1 e bucket R2. Não criar, atualizar, restaurar, excluir, sobrescrever dados, cobrar ou publicar código. Não executar restauros existentes sem destino isolado e aprovação explícita de custos.

CI antecede a etapa; log exibe somente booleanos e próximos passos, nunca token/ID privado. Produção intocada.
