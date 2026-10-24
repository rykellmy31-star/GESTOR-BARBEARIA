-- Data em que um administrador registrou o pagamento do pedido.
-- Pedidos históricos pagos não possuem data verificável: preservar NULL,
-- nunca inventar uma data a partir de created_at ou updated_at.
ALTER TABLE orders ADD COLUMN paid_at TEXT;
CREATE INDEX IF NOT EXISTS idx_orders_company_paid_at ON orders(company_id, paid_at);
