-- Reconciliação idempotente das notificações de recargas confirmadas.
-- Recargas já pagas no momento da migração são consideradas históricas:
-- não recriar notificações antigas cujo envio não era correlacionável.
ALTER TABLE topup_orders ADD COLUMN notification_sent_at TEXT;
UPDATE topup_orders SET notification_sent_at=COALESCE(credited_at,paid_at,updated_at)
 WHERE status='paid';
CREATE INDEX IF NOT EXISTS idx_topups_notification_reconcile
 ON topup_orders(status, notification_sent_at, id);
