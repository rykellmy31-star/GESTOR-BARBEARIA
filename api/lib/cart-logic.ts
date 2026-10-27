export const MAX_CART_QTY = 20;
export const MAX_CART_LINES = 20;

/** localStorage pode conter JSON manipulado: nunca confiar nas quantidades. */
export function normalizeCart(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const result: Record<string, number> = {};
  for (const [id, quantity] of Object.entries(raw)) {
    if (Object.keys(result).length === MAX_CART_LINES) break;
    const numericId = Number(id);
    if (!/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(numericId) ||
        typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity <= 0) continue;
    result[id] = Math.min(quantity, MAX_CART_QTY);
  }
  return result;
}

/** Remove itens inexistentes/esgotados e reduz quantidades ao estoque real. */
export function reconcileCart(raw: unknown, products: {id:number;stock:number}[]): Record<string, number> {
  const stock = new Map(products.map(p => [String(p.id), p.stock]));
  const cart = normalizeCart(raw);
  for (const [id, quantity] of Object.entries(cart)) {
    const available = stock.get(id);
    if (typeof available !== "number" || !Number.isSafeInteger(available) || available <= 0) {
      delete cart[id];
    } else {
      cart[id] = Math.min(quantity, available);
    }
  }
  return cart;
}

