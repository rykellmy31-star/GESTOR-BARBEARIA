# TIGU — Passagem técnica para homologação e recuperação de backups

**Data:** 21/10/2026  
**Projeto:** `rykellmy31-star/GESTOR-BARBEARIA`  
**Branch:** `audit/tigu-primeira-validacao`  
**PR:** [#1, rascunho](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/pull/1)  
**Última revisão funcional aprovada:** `cef08747f1b0cc25b22af7a9ba19ef6089bad6b5`.

## Situação comprovada em ambiente isolado local

- GitHub Actions da revisão acima: [Push aprovado](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39599094335) e [PR aprovado](https://github.com/rykellmy31-star/GESTOR-BARBEARIA/actions/runs/39599102311).
- TypeScript e compilação: aprovados.
- Vitest/Workers/D1: **296/296**; Node: **59/59**; cenários HTTP com Worker/D1/R2 local: **81/81**; Chromium com fluxos reais de React: **50/50**.
- Cadastro, login, alteração da senha provisória, Superadmin, multitenancy, profissional, loja, pedido, estoque, serviços, equipe, agenda, consulta, cancelamento e remarcação de reservas passaram em simulação local.
- Fluxo de LGPD do cliente anonimiza cadastro, telefone, reservas encerradas, pedidos, avaliações associadas, fila de mensagens e notificações vinculadas; mantém valores financeiros e usa telefone sintético. Recusa enquanto há pendências e bloqueia recuperação da reserva anonimizada pelo contato anterior.
- Consulta à auditoria administrativa agora possui limite SQL parametrizado, entre 1 e 100.
- Manual de operação atualizado para não recomendar escrita direta no D1 comercial nem restauração de backup em produção.

## Etapas restantes para aceitação da versão candidata

### 1. Homologação Cloudflare, integrações e aprovações de lançamento

- Conferir os identificadores e a separação do D1/R2/Worker de staging **em conta autorizada**. Nunca apontar homologação para recursos comerciais.
- Aplicar todas as migrações no D1 de staging e cadastrar Superadmin fictício com segredos exclusivos. Publicar **apenas mediante autorização**.
- Rodar `STAGING_URL=https://tigu-staging.SUA_SUBCONTA.workers.dev npm run staging:smoke` e os testes completos autenticados pela URL real, inclusive responsividade e isolamento entre empresas.
- Realizar testes de segurança e abuso com Turnstile/WAF configurados para o domínio correto.
- Validar contratos de webhooks, Pix, atrasos/duplicações/estornos e conciliação na conta de testes do Mercado Pago; sem autorização de pagamento real. Validar Meta/WhatsApp com números e templates de teste aprovados. Essas dependências **não foram homologadas com provedores externos**.
- Formalizar Termos de Uso, Política de Privacidade, base legal, retenção e atendimento a titulares, bem como processos comerciais de downgrade e contestação. Isso exige decisão/aprovação do responsável e, quando aplicável, revisão jurídica: não é demonstrado por CI local.
- Verificar observabilidade, domínio, secrets e controles de produção. Sem aprovação explícita, não mesclar PR, não ativar clientes nem cobrar reais.

### 2. Cópia e restauração reais D1 + R2

- Exportar e armazenar uma cópia D1 de origem autorizada, com manifesto, checksum, retenção, acesso restrito e registro da data.
- Restaurar em **banco D1 isolado**, validar integridade, todas as tabelas, vínculos por empresa, lançamentos, estoque e idempotência financeira.
- Copiar objetos do R2 para bucket isolado e conferir quantidade, chaves, tamanhos, hashes e leitura pelo frontend, além de processos de restauração.
- Medir e registrar RPO/RTO, monitoramento e runbook de falhas. Não fazer restore de teste no recurso comercial.
- Os testes atuais de migração e recuperação de SQLite descartável são úteis, mas **não substituem** essa validação no Cloudflare.

## Limites objetivos

**Nenhum recurso remoto, domínio, banco ou bucket de produção foi modificado nesta revisão.** Não houve pagamento real, publicação, migração remota, envio de WhatsApp real nem restauração Cloudflare. O status dos sistemas externos permanece **não verificado**, e a aprovação comercial depende também dos itens de conformidade acima.

Esta passagem organiza as dependências em dois grandes marcos (homologação/aceite e backups), **sem confundir** "CI verde" com "pronto para comercializar".


## Preparação adicional — verificação offline de evidências de backup

O repositório inclui agora `npm run backup:evidence`, que recebe três artefatos **locais** e não possui qualquer integração de escrita com Cloudflare:

```bash
npm run backup:evidence -- \
  --d1-sql /caminho-protegido/export-d1.sql \
  --r2-dir /caminho-protegido/objetos-r2 \
  --r2-manifest /caminho-protegido/manifesto-r2.json
```

O manifesto é um array JSON com uma entrada por **objeto copiado**, por exemplo:

```json
[
  {
    "key": "empresa-ficticia/foto.webp",
    "size": 12345,
    "sha256": "substituir_pelo_hash_sha256_de_64_digitos_hexadecimais"
  }
]
```

O comando recria o export SQL num banco SQLite **em memória**, checa integridade, chaves estrangeiras e tabelas essenciais; para cada objeto listado, compara tamanho e SHA-256 no diretório da cópia, recusando caminhos inseguros, duplicatas e links simbólicos. A saída mostra apenas indicadores agregados. Use exclusivamente exports obtidos de origem confiável, em ambiente restrito.

**O comando não prova** que o manifesto contém todos os objetos que existiam no R2, que o arquivo SQL corresponde ao D1 de origem, que as cópias estão criptografadas/retenidas fora da conta ou que uma **restauração remota controlada** teria sucesso. É obrigatório obter também um inventário assinado ou protegido na origem, comparar a listagem completa e executar o restore separado com conferência de fotos, dados financeiros e disponibilidade. Não copiar artefatos reais para repositórios ou chats.

Os testes do utilitário são executados pelo GitHub Actions com apenas dados fictícios. Ainda falta a homologação real dos backups D1 e R2 na Cloudflare.
