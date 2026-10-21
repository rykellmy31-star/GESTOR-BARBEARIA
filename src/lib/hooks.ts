import { useEffect, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";
import type { ShopSettings } from "./types";

export interface CompanyRef { slug: string; name: string; role: string; plan: string; status?: string; subscription_status?: "trial" | "active" | "past_due" | "cancelled"; trial_end?: string | null; price_cents_month?: number }
export interface TiguUser { id: number; name: string; email: string; platform_role: "user" | "superadmin"; companies?: CompanyRef[]; must_change_password?: boolean }

/** config pública da empresa (tema injetado no CSS) — só existe sob /c/:slug */
export function useConfig(enabled = true) {
  const isCompany = /^\/c\//.test(location.pathname);
  const q = useQuery({
    queryKey: ["config", location.pathname.split("/")[2]],
    queryFn: () => api.get<{ settings: ShopSettings; demo_active?: boolean; company?: { slug: string; name: string } }>("/config"),
    staleTime: 20_000,
    enabled: enabled && isCompany,
  });
  useEffect(() => {
    const s = q.data?.settings;
    if (!s) return;
    const r = document.documentElement;
    r.style.setProperty("--c-gold", s.brand?.gold || "#d4af37");
    r.style.setProperty("--c-ink", s.brand?.ink || "#0a0a0c");
    r.style.setProperty("--c-panel", s.brand?.panel || "#16161c");
    r.style.setProperty("--c-line", s.brand?.line || "#26262f");
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", s.brand?.ink || "#0a0a0c");
    document.title = `${s.shop_name} — Tigu`;
  }, [q.data]);
  return q;
}

export function useAuth() {
  const qc = useQueryClient();
  const me = useQuery({
    queryKey: ["auth-me"],
    queryFn: () => api.get<{ user: TiguUser | null }>("/auth/me").then((d) => d.user),
    staleTime: 15_000,
  });
  const login = useMutation({
    mutationFn: (creds: { email: string; password: string }) => api.post<{ user: TiguUser; companies: CompanyRef[]; next: string }>("/auth/login", creds),
    onSuccess: async (data) => {
      // O Gate precisa ver a nova sessão ANTES de navegar para o painel.
      // Invalidar sem await deixava auth-me=null e redirecionava de volta ao login.
      qc.setQueryData<TiguUser>(["auth-me"], { ...data.user, companies: data.companies });
      await qc.invalidateQueries({ queryKey: ["auth-me"] });
    },
  });
  const logout = useMutation({
    mutationFn: () => api.post("/auth/logout"),
    onSuccess: async () => {
      qc.setQueryData(["auth-me"], null);
      await qc.invalidateQueries();
    },
  });
  const register = useMutation({
    mutationFn: (data: { company_name: string; email: string; password: string; name: string; phone?: string }) => api.post<{ ok: boolean; company: { slug: string }; next: string }>("/auth/register", data),
    onSuccess: async () => {
      // Cadastro também cria sessão; espere /me antes de montar a área protegida.
      await qc.invalidateQueries({ queryKey: ["auth-me"] });
    },
  });
  const changePassword = useMutation({
    mutationFn: (data: { current: string; next: string }) => api.post("/auth/password", data),
  });
  const recover = useMutation({ mutationFn: (email: string) => api.post<{ message: string; demo_code?: string; support_required?: boolean }>("/auth/recover", { email }) });
  const recoverVerify = useMutation({ mutationFn: (d: { email: string; code: string; password: string }) => api.post("/auth/recover/verify", d) });
  return { me, user: me.data ?? null, login, logout, register, changePassword, recover, recoverVerify, refetchMe: me.refetch };
}

/** sino de notificações com polling (sem push externo; sincroniza sozinho) */
export function useNotifications(panel: "admin" | "barber") {
  const isCompany = /^\/c\//.test(location.pathname);
  const base = panel === "admin" ? "/admin/notifications" : "/barber/notifications";
  const q = useQuery({
    queryKey: [base, location.pathname.split("/")[2]],
    queryFn: () => api.get<{ notifications: any[]; unread: number }>(base),
    refetchInterval: 12_000,
    refetchIntervalInBackground: false,
    enabled: isCompany,
  });
  const markAll = useMutation({
    mutationFn: () => api.post(`${base}/read`),
    onSuccess: () => q.refetch(),
  });
  return { ...q, markAll };
}

/** revelação no scroll (.reveal.in) */
export function useReveal(deps: unknown[] = []) {
  useEffect(() => {
    const els = document.querySelectorAll<HTMLElement>(".reveal:not(.in)");
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }, { rootMargin: "0px 0px -8% 0px", threshold: 0.06 });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function useBodyScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = prev; };
  }, [locked]);
}

/** papel do usuário na empresa do contexto atual (owner/manager/barber|null) */
export function useCompanyRole(user: TiguUser | null | undefined): CompanyRef | null {
  return useMemo(() => {
    const m = location.pathname.match(/^\/c\/([a-z0-9-]+)/);
    if (!m || !user?.companies) return null;
    return user.companies.find((c) => c.slug === m[1]) ?? null;
  }, [user]);
}
