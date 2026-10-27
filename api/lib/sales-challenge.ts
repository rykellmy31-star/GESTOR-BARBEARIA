import type { Env } from "../types";

/** Formulários comerciais só podem funcionar sem desafio no desenvolvimento local. */
export function salesChallengeConfig(env: Env) {
  const required = env.APP_ENV === "production";
  return {
    required,
    enabled: !required || Boolean(env.SALES_TURNSTILE_SITE_KEY && env.SALES_TURNSTILE_SECRET),
    site_key: required && env.SALES_TURNSTILE_SITE_KEY && env.SALES_TURNSTILE_SECRET
      ? env.SALES_TURNSTILE_SITE_KEY : null,
  };
}

export async function verifySalesTurnstile(
  env: Env,
  token: string | undefined,
  ip: string | null
): Promise<"ok" | "missing_config" | "invalid"> {
  if (env.APP_ENV !== "production") return "ok";
  if (!env.SALES_TURNSTILE_SITE_KEY || !env.SALES_TURNSTILE_SECRET) return "missing_config";
  if (!token || token.length > 2048) return "invalid";
  try {
    const body = new URLSearchParams({ secret: env.SALES_TURNSTILE_SECRET, response: token });
    if (ip) body.set("remoteip", ip);
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(6_000),
    });
    if (!response.ok) return "invalid";
    const result = await response.json() as { success?: boolean; hostname?: string };
    return result.success === true ? "ok" : "invalid";
  } catch {
    // Falha de rede não deve permitir passar sem anti-bot.
    return "invalid";
  }
}
