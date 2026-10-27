import type { Env as TiguEnv } from "../api/types";

declare global {
  namespace Cloudflare {
    interface Env extends TiguEnv {}
  }
}
