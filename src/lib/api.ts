// Cliente da API — tipado, com base dinâmica por contexto multiempresa:
//   /c/<slug>/**     → /api/c/<slug>/**      (site + painel da barbearia)
//   /superadmin/**   → /api/super/**          (suíte Tigu)
//   resto            → /api/**                (auth global, onboarding)
export interface ApiError extends Error {
  status: number;
  details?: unknown;
}

function currentCompanySlug(): string | null {
  const m = location.pathname.match(/^\/c\/([a-z0-9-]+)/);
  return m ? m[1] : null;
}

/** prefixo do site da barbearia atual ("" fora de /c/:slug) */
export function siteBase(): string {
  const s = currentCompanySlug();
  return s ? `/c/${s}` : "";
}

function apiPrefix(): string {
  const s = currentCompanySlug();
  if (s) return `/api/c/${s}`;
  if (location.pathname.startsWith("/superadmin")) return "/api/super";
  return "/api";
}


/**
 * Normaliza URLs explícitas de módulos sem duplicar `/super` ou `/auth`.
 * Permite também o uso do prefixo relativo dentro de cada painel.
 */
export function resolveApiUrl(path: string, pathname: string): string {
  if (/^https?:\/\//i.test(path) || path.startsWith("/api/")) return path;
  if (!path.startsWith("/")) throw new Error("Os caminhos da API precisam começar com /");
  if (/^\/(?:super|auth)(?:\/|$)/.test(path)) return `/api${path}`;
  const match = pathname.match(/^\/c\/([a-z0-9-]+)/);
  if (match) return `/api/c/${match[1]}${path}`;
  if (pathname.startsWith("/superadmin")) return `/api/super${path}`;
  return `/api${path}`;
}

async function request<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const url = resolveApiUrl(path, location.pathname);
  const res = await fetch(url, {
    credentials: "same-origin",
    ...init,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
  const text = await res.text();
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) {
    const e: ApiError = Object.assign(new Error(body?.error || `Erro ${res.status}`), {
      status: res.status,
      details: body?.details,
    });
    throw e;
  }
  return body as T;
}

export const api = {
  get: <T = any>(path: string, signal?: AbortSignal) => request<T>(path, { method: "GET", signal }),
  post: <T = any>(path: string, data?: unknown) => request<T>(path, { method: "POST", body: data === undefined ? undefined : JSON.stringify(data) }),
  put: <T = any>(path: string, data?: unknown) => request<T>(path, { method: "PUT", body: JSON.stringify(data) }),
  patch: <T = any>(path: string, data?: unknown) => request<T>(path, { method: "PATCH", body: JSON.stringify(data) }),
  del: <T = any>(path: string, data?: unknown) => request<T>(path, { method: "DELETE", body: data === undefined ? undefined : JSON.stringify(data) }),
  /** upload p/ o painel da barbearia (R2) */
  upload: async (file: File): Promise<string> => {
    const fd = new FormData();
    fd.append("file", file);
    const base = apiPrefix();
    const res = await fetch(`${base}/admin/upload`, { method: "POST", body: fd, credentials: "same-origin" });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body?.error || "Falha no upload"), { status: res.status });
    return body.url as string;
  },
};

export function cartKey(): string {
  return `tigu_cart_${currentCompanySlug() ?? "default"}`;
}
export function cartEvent(): string {
  return "tigu:cart";
}
