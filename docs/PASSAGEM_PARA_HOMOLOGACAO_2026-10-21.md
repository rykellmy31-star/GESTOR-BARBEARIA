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
