/** Converte um valor BRL escrito na interface em centavos inteiros. */
export function parseTopupAmountCents(raw: string): number | null {
  const value = raw.trim();
  const grouped = /^\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?$/.test(value);
  const simple = /^\d+(?:[,.]\d{1,2})?$/.test(value);
  if (!grouped && !simple) return null;
  const decimal = grouped ? value.replace(/\./g, "").replace(",", ".") : value.replace(",", ".");
  const [whole, fraction = ""] = decimal.split(".");
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : null;
}
