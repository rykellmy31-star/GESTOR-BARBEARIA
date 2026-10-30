# Retomada da publicação no domínio oficial

O fluxo de deploy anterior foi bloqueado antes de publicar, por duas verificações do contrato de testes, corrigidas para contemplar a habilitação independente e isolada da Evolution API.

Este gatilho volta a executar verificações locais e, se aprovadas, publica **somente** no Worker que atende ao domínio oficial agendamentos.crjornada.com. Não há deploy em staging ou ambiente separado. A publicação mantém D1, R2, DNS, pagamentos e segredos existentes.
