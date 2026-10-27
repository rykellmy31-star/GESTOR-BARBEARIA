// Validação por chave das configurações financeiras do Super Admin.
// A API recebe JSON: nunca aceitar strings onde se esperam centavos inteiros.
export const platformSettingLimits = {
  msg_price_cents: [0, 100_000_000],
  msg_cost_cents: [0, 100_000_000],
  msg_max_attempts: [1, 10],
  retry_backoff_sec: [1, 86_400],
  topup_min_cents: [1, 100_000_000],
  topup_max_cents: [1, 100_000_000],
  low_balance_alert_cents: [0, 100_000_000],
  reminder_lead_min: [0, 1_440],
} as const;

export function isValidPlatformSetting(key: string, value: unknown): boolean {
  if (key === 'capture_on') return value === 'sent' || value === 'delivered';
  if (!Object.prototype.hasOwnProperty.call(platformSettingLimits, key)) return false;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) return false;
  const [min, max] = platformSettingLimits[key as keyof typeof platformSettingLimits];
  return value >= min && value <= max;
}
