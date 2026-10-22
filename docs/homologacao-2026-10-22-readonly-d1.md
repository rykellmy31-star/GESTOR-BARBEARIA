# TIGU — homologação real de backup D1 (22/10/2026)

Continuidade da homologação requisitada pelo proprietário, visando atingir 100% funcional, sem recriar projeto nem alterar produção.

Autorizado **exclusivamente** o gatilho `TIGU_VERIFY_D1_EXPORT_ONCE` da branch `audit/tigu-primeira-validacao`.

Objetivo: inventariar por GET os recursos de staging `tigu-staging`, `tigu-staging-db` e `tigu-staging-media`; exportar **somente leitura** o D1 existente via Wrangler; restaurar export em SQLite temporário no runner; checar integridade, chaves estrangeiras e tabelas essenciais; descartar SQL e não publicar dumps.

Não executar INSERT/UPDATE/DELETE, não recriar D1/R2, não aplicar migrations, não emitir Pix e não tocar em produção. Registrar nos logs somente resumo técnico, nunca dados de clientes.

Estado identificado em auditoria pública atual: site de homologação está online; Mercado Pago real e Meta WhatsApp real inativos, Turnstile da captação de leads desconfigurado e contato comercial desativado. Esses bloqueios serão tratados separadamente e não devem ser declarados resolvidos pelo backup.
