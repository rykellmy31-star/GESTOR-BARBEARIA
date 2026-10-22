/// <reference types="@cloudflare/vitest-plugin/types" />
import { beforeAll, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import schema from "../migrations/0001_init.sql";
import { app } from "../api/index";
import { sha256hex } from "../api/lib/crypto";
import type { Env } from "../api/types";
const db=env.DB as D1Database;
const e={...env,APP_ENV:"development",SESSION_SECRET:"super-membership-test-secret-at-least-32"} as Env;
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}} as unknown as ExecutionContext;
beforeAll(async()=>{
  for(const sql of schema.replace(/--[^\n]*/g,"").split(";").map(s=>s.trim()).filter(Boolean)) await db.prepare(sql).run();
});
async function user(role="user"){
  const email=`super-membership-${crypto.randomUUID()}@tigu.test`;
  const id=Number((await db.prepare("INSERT INTO users(name,email,password_hash,platform_role) VALUES ('Pessoa',?1,'original-hash',?2)").bind(email,role).run()).meta.last_row_id);
  const token=crypto.randomUUID();
  await db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?1,?2,?3)").bind(await sha256hex(`${token}:${e.SESSION_SECRET}:${id}`),id,new Date(Date.now()+86400000).toISOString()).run();
  return {id,email,cookie:`aurum_session=uid.${id}.${token}`};
}
async function fixture(){
  const actor=await user("superadmin"),target=await user();
  const createCompany=async()=>{
    const slug=`membership-${crypto.randomUUID()}`;
    const id=Number((await db.prepare("INSERT INTO companies(slug,name) VALUES (?1,'Empresa de teste')").bind(slug).run()).meta.last_row_id);
    const barber=Number((await db.prepare("INSERT INTO barbers(company_id,slug,name) VALUES (?1,?2,'Profissional')").bind(id,slug).run()).meta.last_row_id);
    await db.prepare("INSERT INTO subscriptions(company_id,plan_code,status,period_end) VALUES (?1,'pro','active',?2)").bind(id,new Date(Date.now()+86400000).toISOString()).run();
    return {id,slug,barber};
  };
  const a=await createCompany(),b=await createCompany();
  const request=(body:object,cookie=actor.cookie)=>app.request("/api/super/memberships",{method:"POST",headers:{"content-type":"application/json",cookie},body:JSON.stringify(body)},e,ctx);
  const member=()=>db.prepare("SELECT role,barber_id,active FROM company_memberships WHERE company_id=?1 AND user_id=?2").bind(a.id,target.id).first();
  return {actor,target,a,b,request,member};
}
describe("Superadmin: isolamento de vínculos de acesso",()=>{
  it("recusa profissional de outra empresa sem criar vínculo",async()=>{
    const f=await fixture();
    expect((await f.request({company_id:f.a.id,user_id:f.target.id,role:"barber",barber_id:f.b.barber})).status).toBe(422);
    expect(await f.member()).toBeNull();
    const access=await app.request(`/api/c/${f.a.slug}/barber/me`,{headers:{cookie:f.target.cookie}},e,ctx);
    expect(access.status).toBe(403);
  });
  it("tentativa inválida não substitui vínculo existente",async()=>{
    const f=await fixture();
    expect((await f.request({company_id:f.a.id,user_id:f.target.id,role:"manager"})).status).toBe(200);
    expect((await f.request({company_id:f.a.id,user_id:f.target.id,role:"barber",barber_id:f.b.barber})).status).toBe(422);
    expect(await f.member()).toEqual({role:"manager",barber_id:null,active:1});
  });
  it("exige profissional ativo da empresa para papel de barbeiro",async()=>{
    const f=await fixture();
    const base={company_id:f.a.id,user_id:f.target.id,role:"barber"};
    expect((await f.request(base)).status).toBe(422);
    await db.prepare("UPDATE barbers SET active=0 WHERE id=?1").bind(f.a.barber).run();
    expect((await f.request({...base,barber_id:f.a.barber})).status).toBe(422);
    await db.prepare("UPDATE barbers SET active=1 WHERE id=?1").bind(f.a.barber).run();
    expect((await f.request({...base,barber_id:f.a.barber})).status).toBe(200);
    expect(await f.member()).toEqual({role:"barber",barber_id:f.a.barber,active:1});
  });
  it("recusa usuário inexistente e desativado sem erro interno ou vínculo",async()=>{
    const f=await fixture();
    expect((await f.request({company_id:f.a.id,user_id:2147483647,role:"owner"})).status).toBe(404);
    await db.prepare("UPDATE users SET active=0 WHERE id=?1").bind(f.target.id).run();
    expect((await f.request({company_id:f.a.id,user_id:f.target.id,role:"owner"})).status).toBe(409);
    expect(await f.member()).toBeNull();
  });
  it("normaliza e-mail e limpa vínculo de profissional ao trocar para gerente",async()=>{
    const f=await fixture();
    expect((await f.request({company_id:f.a.id,email:` ${f.target.email.toUpperCase()} `,role:"barber",barber_id:f.a.barber})).status).toBe(200);
    expect((await f.request({company_id:f.a.id,user_id:f.target.id,role:"manager",barber_id:f.a.barber})).status).toBe(200);
    expect(await f.member()).toEqual({role:"manager",barber_id:null,active:1});
  });
  it("usuário comum não pode conceder acesso",async()=>{
    const f=await fixture();
    expect((await f.request({company_id:f.a.id,user_id:f.target.id,role:"owner"},f.target.cookie)).status).toBe(403);
    expect(await f.member()).toBeNull();
  });
});


describe("Superadmin: consulta de painéis de empresas sem vínculo explícito", () => {
  it("carrega abas administrativas e carteira exclusivamente no tenant solicitado", async () => {
    const f = await fixture();
    for (const company of [f.a, f.b]) {
      const response = await app.request(`/api/c/${company.slug}/admin/services`,
        { headers: { cookie: f.actor.cookie } }, e, ctx);
      expect(response.status).toBe(200);
      expect(response.headers.get("X-Tigu-Support-Mode")).toBe("read-only");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      const json = await response.json() as { services: Array<{company_id?:number}> };
      expect(Array.isArray(json.services)).toBe(true);
    }
    const wallet = await app.request(`/api/c/${f.a.slug}/admin/wallet`,
      { headers: { cookie: f.actor.cookie } }, e, ctx);
    expect(wallet.status).toBe(200);
    expect((await wallet.json() as {topups:unknown[]}).topups).toEqual([]);
  });
  it("impede qualquer alteração via painel assumido e mantém RBAC para contas comuns", async () => {
    const f = await fixture();
    const endpoint=`/api/c/${f.a.slug}/admin/notifications/read`;
    const supportWrite=await app.request(endpoint,
      {method:"POST",headers:{cookie:f.actor.cookie}},e,ctx);
    expect(supportWrite.status).toBe(403);
    const noMembership=await app.request(`/api/c/${f.a.slug}/admin/services`,
      {headers:{cookie:f.target.cookie}},e,ctx);
    expect(noMembership.status).toBe(403);
    const noBarberBypass=await app.request(`/api/c/${f.a.slug}/barber/me`,
      {headers:{cookie:f.actor.cookie}},e,ctx);
    expect(noBarberBypass.status).toBe(403);
    // Um proprietário REAL continua apto a gerir sua empresa.
    const link=await f.request({company_id:f.a.id,user_id:f.target.id,role:"owner"});
    expect(link.status).toBe(200);
    const ownerRead=await app.request(`/api/c/${f.a.slug}/admin/services`,
      {headers:{cookie:f.target.cookie}},e,ctx);
    expect(ownerRead.status).toBe(200);
    expect(ownerRead.headers.get("X-Tigu-Support-Mode")).toBeNull();
    const ownerWrite=await app.request(endpoint,
      {method:"POST",headers:{cookie:f.target.cookie}},e,ctx);
    expect(ownerWrite.status).toBe(200);
  });
  it("não contorna bloqueio da empresa suspensa", async () => {
    const f=await fixture();
    await db.prepare("UPDATE companies SET status='suspended' WHERE id=?1").bind(f.a.id).run();
    const response=await app.request(`/api/c/${f.a.slug}/admin/services`,
      {headers:{cookie:f.actor.cookie}},e,ctx);
    expect(response.status).toBe(403);
  });
});


describe("Super Admin: reenviar dados de acesso e renovar senha do proprietário",()=>{
  const reset=(companyId:number,userId:number,cookie:string)=>
    app.request(`/api/super/companies/${companyId}/owners/${userId}/reset-access`,
      {method:"POST",headers:{cookie,"content-type":"application/json"},body:"{}"},e,ctx);

  it("devolve dados reais do plano e sua validade, sem expor o hash de senha",async()=>{
    const f=await fixture();
    await f.request({company_id:f.a.id,user_id:f.target.id,role:"owner"});
    const res=await app.request(`/api/super/companies/${f.a.id}`,
      {headers:{cookie:f.actor.cookie}},e,ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body=await res.json() as {
      subscription:{plan_code:string;status:string;period_end:string},
      members:Array<{user_id:number;email:string;role:string}>
    };
    expect(body.subscription.plan_code).toBe("pro");
    expect(body.subscription.status).toBe("active");
    expect(body.subscription.period_end).toBeTruthy();
    expect(body.members.some(m=>m.user_id===f.target.id&&m.role==="owner")).toBe(true);
    expect(JSON.stringify(body)).not.toContain("original-hash");
  });

  it("gera senha aleatória temporária somente para dono ativo, expira sessões e exige troca",async()=>{
    const f=await fixture();
    await f.request({company_id:f.a.id,user_id:f.target.id,role:"owner"});
    const response=await reset(f.a.id,f.target.id,f.actor.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const payload=await response.json() as {generated_password:string;requires_password_change:boolean};
    expect(payload.generated_password).toMatch(/^Tigu![a-f0-9]{36}$/);
    expect(payload.requires_password_change).toBe(true);
    const stored=await db.prepare("SELECT password_hash,must_change_password FROM users WHERE id=?1")
      .bind(f.target.id).first<{password_hash:string;must_change_password:number}>();
    expect(stored?.password_hash).not.toContain(payload.generated_password);
    expect(stored?.password_hash).not.toBe("original-hash");
    expect(stored?.must_change_password).toBe(1);
    const sessionCount=await db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id=?1")
      .bind(f.target.id).first<{n:number}>();
    expect(sessionCount?.n).toBe(0);
    const tenantDenied=await app.request(`/api/c/${f.a.slug}/admin/services`,
      {headers:{cookie:f.target.cookie}},e,ctx);
    expect(tenantDenied.status).toBe(401);
  });

  it("nega redefine de outro tenant, usuário comum e usuário sem papel de owner",async()=>{
    const f=await fixture();
    await f.request({company_id:f.b.id,user_id:f.target.id,role:"owner"});
    expect((await reset(f.a.id,f.target.id,f.actor.cookie)).status).toBe(403);
    expect((await reset(f.b.id,f.target.id,f.target.cookie)).status).toBe(403);
    await f.request({company_id:f.a.id,user_id:f.target.id,role:"manager"});
    expect((await reset(f.a.id,f.target.id,f.actor.cookie)).status).toBe(403);
    const stored=await db.prepare("SELECT password_hash FROM users WHERE id=?1").bind(f.target.id).first<{password_hash:string}>();
    expect(stored?.password_hash).toBe("original-hash");
  });

  it("não reseta login compartilhado por várias empresas",async()=>{
    const f=await fixture();
    await f.request({company_id:f.a.id,user_id:f.target.id,role:"owner"});
    await f.request({company_id:f.b.id,user_id:f.target.id,role:"owner"});
    expect((await reset(f.a.id,f.target.id,f.actor.cookie)).status).toBe(409);
    expect((await db.prepare("SELECT password_hash FROM users WHERE id=?1").bind(f.target.id)
      .first<{password_hash:string}>())?.password_hash).toBe("original-hash");
  });
});


describe("Super Admin: diagnóstico sem exposição de segredos",()=>{
  it("exige sessão de superadmin mesmo para consultar o estado das integrações", async()=>{
    const withoutSession=await app.request("/api/super/integrations/status",{},e,ctx);
    expect(withoutSession.status).toBe(401);
    const f=await fixture();
    const ordinary=await app.request("/api/super/integrations/status",
      {headers:{cookie:f.target.cookie}},e,ctx);
    expect(ordinary.status).toBe(403);
  });

  it("mostra Turnstile, contato e bloqueio de staging sem divulgar credenciais",async()=>{
    const f=await fixture();
    const envWithSecrets={
      ...e,
      TIGU_STAGING:"1",
      SALES_TURNSTILE_SITE_KEY:"public-sitekey-for-test",
      SALES_TURNSTILE_SECRET:"private-turnstile-secret-must-not-appear",
      MP_ACCESS_TOKEN:"private-mercadopago-secret-must-not-appear",
      MP_WEBHOOK_SECRET:"private-webhook-secret-must-not-appear",
      WHATSAPP_APP_SECRET:"private-whatsapp-secret-must-not-appear",
      MSG_ENC_KEY:"private-messaging-encryption-secret-must-not-appear",
    } as Env;
    const response=await app.request("/api/super/integrations/status",
      {headers:{cookie:f.actor.cookie}},envWithSecrets,ctx);
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const body=await response.json() as {
      staging:boolean;
      readiness:{turnstile_site_key_set:boolean;turnstile_secret_set:boolean;
        leads_form_ready:boolean;production_site_ready:boolean;sales_contact_enabled:boolean};
      payment:{access_token_set:boolean;enabled_in_environment:boolean};
    };
    expect(body.staging).toBe(true);
    expect(body.readiness.turnstile_site_key_set).toBe(true);
    expect(body.readiness.turnstile_secret_set).toBe(true);
    expect(body.readiness.leads_form_ready).toBe(true);
    expect(body.readiness.production_site_ready).toBe(false);
    expect(body.readiness.sales_contact_enabled).toBe(false);
    expect(body.payment.access_token_set).toBe(true);
    expect(body.payment.enabled_in_environment).toBe(false);
    const json=JSON.stringify(body);
    for(const secret of ["private-turnstile-secret-must-not-appear",
      "private-mercadopago-secret-must-not-appear","private-webhook-secret-must-not-appear",
      "private-whatsapp-secret-must-not-appear","private-messaging-encryption-secret-must-not-appear"])
      expect(json).not.toContain(secret);
  });
});
