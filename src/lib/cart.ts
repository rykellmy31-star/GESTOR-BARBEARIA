import { cartEvent, cartKey } from "./api";
import { normalizeCart } from "../../api/lib/cart-logic";

export { MAX_CART_QTY, MAX_CART_LINES, normalizeCart, reconcileCart } from "../../api/lib/cart-logic";

export function readCart(): Record<string, number> {
  try { return normalizeCart(JSON.parse(localStorage.getItem(cartKey()) || "{}")); }
  catch { return {}; }
}

export function writeCart(cart: Record<string, number>): void {
  localStorage.setItem(cartKey(), JSON.stringify(normalizeCart(cart)));
  window.dispatchEvent(new Event(cartEvent()));
}
