# Tigu — uploads e privacidade HTTP

Data: 19/10/2026. Branch: `audit/tigu-primeira-validacao`.
Base: `24b01d334e667452d48083a5984a85e491e4e707`.

## Alterações realizadas

- Upload limitado durante a leitura dos bytes reais, inclusive sem Content-Length ou com tamanho declarado menor. O corpo multipart aceita até 5 MiB + 64 KiB; o arquivo aceita até 5 MiB.
- Assinaturas de contêiner JPEG, PNG, WebP e AVIF conferidas antes de gravar no R2. Arquivos vazios, formatos divergentes e SVG são recusados. O identificador do objeto agora usa UUID criptográfico.
- Respostas de imagens incluem `X-Content-Type-Options: nosniff` e CSP `default-src 'none'; sandbox`. Metadados de tipos não permitidos em objetos legados são entregues como `application/octet-stream`.
- Todas as respostas da API recebem `Cache-Control: no-store`, `X-Content-Type-Options: nosniff` e `Referrer-Policy: no-referrer`, incluindo recusas de origem, rotas inexistentes e erros internos.
- HTML inclui política de referrer, conferida também no build. Erros de produção usam mensagem pública sem comandos ou diagnóstico de desenvolvimento.
- Validação HTTP local ampliada de 24 para 28 verificações, com foto percorrendo HTTP/R2 local, recusa de tipo falsificado e conferência de privacidade das respostas e do HTML.

## Commits de implementação

| Commit | Alteração |
|---|---|
| `9ed2b13912fec4a799493319c9def704deb9c6d2` | Limites, assinaturas, gravação e entrega das imagens |
| `8d9a6c12b7088bcfb830d5d146c6942197989e93` | Privacidade de respostas, erros e validação HTTP ampliada |

Este relatório, o guia e o checklist são registrados em um commit adicional de documentação.

## Testes realmente executados

- `npx vitest run tests/image-upload.test.ts`: 7 testes aprovados no Worker/R2 locais.
- `npm run validate` após o primeiro conjunto: 212 testes em 25 arquivos, 21 testes de scripts/configuração, tipagem e build aprovados; auditoria com zero vulnerabilidades.
- `node scripts/local-e2e.mjs`, após o build atualizado: 28 verificações HTTP aprovadas, com dez migrações em banco temporário e dados fictícios. O processo encerrou e removeu a persistência temporária.
- `npm run validate` final: **215 testes em 26 arquivos + 21 testes de scripts/configuração**, tipagem e build aprovados; auditoria com zero vulnerabilidades.
- A primeira execução do novo teste de privacidade falhou porque seu banco de teste não tinha a tabela de limite de requisições. O fixture passou a aplicar a migração 0006; a suíte completa foi executada novamente e aprovada.
- `node --test scripts/ci-policy.test.mjs` e `node --check scripts/local-e2e.mjs` também aprovados.

## Limites e pendências

A conferência de assinatura não decodifica a imagem nem promete validar todos os seus pixels. Não utiliza serviço externo ou transforma as imagens. A aparência das fotos e das telas ainda precisa ser conferida em navegador funcional.

Homologação Cloudflare/HTTPS, migrações remotas autorizadas, credenciais e webhooks Mercado Pago/Meta, termos, privacidade, suporte, backup e recuperação continuam pendentes no checklist. O teste local não comprova esses itens. Não declarar o projeto 100% pronto para produção com base no número de testes.

Nenhuma alteração na main, em segredos, outros projetos, produção ou orçamentos. Nenhum recurso pago, deploy, migração remota, Pix real ou envio real de WhatsApp foi executado. Workflow permanece exclusivamente manual; commits usam `[skip ci]`.
