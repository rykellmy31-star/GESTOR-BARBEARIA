/**
 * Roteamento HTTP compartilhado pela aplicação React e pelos testes Workers.
 * Não depende do navegador (DOM), para que a mesma regra seja testável no CI.
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
