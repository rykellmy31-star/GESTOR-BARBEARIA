import { useEffect, useRef } from "react";

type TurnstileApi = {
  render: (container: HTMLElement, options: {
    sitekey: string;
    callback: (token: string) => void;
    "error-callback": () => void;
    "expired-callback": () => void;
  }) => string;
  remove: (id: string) => void;
  reset: (id: string) => void;
};

declare global {
  interface Window { turnstile?: TurnstileApi; }
}

const scriptId = "tigu-sales-turnstile";

/** Carrega o desafio somente na página comercial e nunca recebe o secret. */
export function SalesTurnstile({
  siteKey, onToken
}: { siteKey: string; onToken: (token: string) => void }) {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    let widgetId: string | undefined;
    const mount = () => {
      if (!active || !container.current || !window.turnstile || widgetId) return;
      widgetId = window.turnstile.render(container.current, {
        sitekey: siteKey,
        callback: onToken,
        "expired-callback": () => onToken(""),
        "error-callback": () => onToken(""),
      });
    };
    let script = document.getElementById(scriptId) as HTMLScriptElement | null;
    const created = !script;
    if (!script) {
      script = document.createElement("script");
      script.id = scriptId;
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", mount);
    if (window.turnstile) mount();
    // Uma carga que termina após desmontagem não deve criar widgets.
    return () => {
      active = false;
      script?.removeEventListener("load", mount);
      if (widgetId && window.turnstile) window.turnstile.remove(widgetId);
      if (created && !window.turnstile && script?.parentNode) script.parentNode.removeChild(script);
      onToken("");
    };
  }, [siteKey, onToken]);

  return <div className="min-h-[65px]" ref={container} aria-label="Verificação de segurança Cloudflare Turnstile" />;
}
