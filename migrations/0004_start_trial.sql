-- 0004: Tigu Start passa a R$ 19,99/mês após teste grátis de 15 dias.
-- Preserva qualquer preço não zero que o proprietário já tenha configurado.
UPDATE plans SET price_cents_month=1999, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 WHERE code='free' AND demo=0 AND price_cents_month=0;

-- Empresas antigas ainda em 'trial' sem prazo recebem 15 dias a partir
-- desta migração para não serem bloqueadas retroativamente sem aviso.
UPDATE subscriptions
 SET period_end=strftime('%Y-%m-%dT%H:%M:%SZ','now','+15 days'),
     updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now')
 WHERE status='trial' AND period_end IS NULL;
