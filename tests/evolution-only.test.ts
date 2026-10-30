import { describe, expect, it, vi } from "vitest";
import { app } from "../api/index";
import { adminRouter } from "../api/routes/admin";
import { resolveProvider } from "../api/lib/messaging/provider";
import { getConnection } from "../api/lib/messaging/jobs";
import type { Env } from "../api/types";

describe("TIGU: Evolution API é a única integração real de WhatsApp", () => {
  it("remove definitivamente webhook Meta GET e POST (sem autenticar ou tocar D1)", async () => {
    for (const method of ["GET","POST"] as const) {
      const response = await app.request("http://tigu.test/api/webhooks/whatsapp", {
        method, headers: {"content-type":"application/json"},
        ...(method==="POST"?{body:JSON.stringify({entry:[]})}:{}),
      }, {APP_ENV:"production",TIGU_STAGING:"0"} as Env);
      expect(response.status).toBe(404);
    }
  });

  it("não oferece endpoints de token, conexão manual e Embedded Signup da Meta", () => {
    const old=["/whatsapp/connect","/whatsapp/embedded/state","/whatsapp/embedded/exchange"];
    for (const path of old) expect(adminRouter.routes.some(r=>r.path===path)).toBe(false);
    expect(adminRouter.routes.some(r=>r.path.startsWith("/whatsapp/evolution"))).toBe(true);
  });

  it("registros Meta históricos nunca fornecem conexão ativa nem chamam Graph API", async () => {
    const statements:string[]=[];
    const db={
      prepare(sql:string){
        statements.push(sql);
        return {bind:()=>({first:async()=>null})};
      },
    } as unknown as D1Database;
    const conn=await getConnection(db,123);
    expect(conn).toBeNull();
    expect(statements.some(s=>s.includes("evolution_connections"))).toBe(true);
    expect(statements.some(s=>s.includes("provider='mock'"))).toBe(true);
    const calls=vi.spyOn(globalThis,"fetch");
    try{
      const provider=await resolveProvider({
        env:{TIGU_STAGING:"0"},db,demo:false,
        conn:{provider:"meta_cloud",status:"connected"} as never,
      });
      expect(provider.provider).toBeNull();
      expect(calls).not.toHaveBeenCalled();
    }finally{calls.mockRestore();}
  });
});
