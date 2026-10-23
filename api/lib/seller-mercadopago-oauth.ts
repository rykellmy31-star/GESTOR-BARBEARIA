import { Hono } from "hono";
import type { Env } from "../types";
import { encryptSecret, decryptSecret, sha256hex } from "./crypto";
import { randomHex } from "./utils";

const CALLBACK="/api/oauth/mercadopago/callback";
const COOKIE="tigu_mp_oauth_state";
const tenMinutes=600_000;
const noStore={"Cache-Control":"no-store","Referrer-Policy":"no-referrer"};
const isEnabled=(env:Env)=>{
 if(env.TIGU_STAGING==="1"||env.APP_ENV!=="production"||
  !env.MP_MARKETPLACE_CLIENT_ID?.trim()||!env.MP_MARKETPLACE_CLIENT_SECRET?.trim()||
  !env.MP_MARKETPLACE_REDIRECT_URI?.startsWith("https://")||
  !env.MSG_ENC_KEY||env.MSG_ENC_KEY.length<32)return false;
 try {
  const publicUrl=new URL(env.PUBLIC_URL||"");
  if(publicUrl.protocol!=="https:"||publicUrl.username||publicUrl.password||publicUrl.search||publicUrl.hash)return false;
  return env.MP_MARKETPLACE_REDIRECT_URI===new URL(CALLBACK,publicUrl).toString();
 }catch{return false;}
};
function cookie(value:string,maxAge=600){return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=${CALLBACK}; Max-Age=${maxAge}`;}
function safeReturn(slug:string,result:"connected"|"failed"){return `/c/${slug}/painel?mp=${result}`;}
const ascii=(v:string)=>new TextEncoder().encode(v);
const base64url=(a:ArrayBuffer)=>btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
function appUrl(env:Env){
 const u=new URL(env.MP_MARKETPLACE_REDIRECT_URI||"");
 if(u.protocol!=="https:"||u.pathname!==CALLBACK||u.search||u.hash)throw Error("Callback OAuth incorreto.");
 return u.toString();
}
export async function beginSellerOauth(env:Env,identity:{companyId:number;barberId:number;userId:number}){
 if(!isEnabled(env))return {ok:false as const,error:"Conexão OAuth indisponível: a produção precisa estar configurada e homologada."};
 const state=randomHex(32),verifier=base64url(crypto.getRandomValues(new Uint8Array(32)).buffer);
 const challenge=base64url(await crypto.subtle.digest("SHA-256",ascii(verifier)));
 const encrypted=await encryptSecret(env,verifier);
 const expires=new Date(Date.now()+tenMinutes).toISOString();
 await env.DB.prepare(`INSERT INTO seller_mp_oauth_pending(state_hash,company_id,barber_id,user_id,verifier_ciphertext,expires_at)
 VALUES (?1,?2,?3,?4,?5,?6)`).bind(await sha256hex(state),identity.companyId,identity.barberId,identity.userId,encrypted,expires).run();
 const u=new URL("https://auth.mercadopago.com/authorization");
 u.searchParams.set("client_id",env.MP_MARKETPLACE_CLIENT_ID!);
 u.searchParams.set("response_type","code");
 u.searchParams.set("platform_id","mp");
 u.searchParams.set("state",state);
 u.searchParams.set("redirect_uri",appUrl(env));
 u.searchParams.set("code_challenge",challenge);
 u.searchParams.set("code_challenge_method","S256");
 return {ok:true as const,authorization_url:u.toString(),set_cookie:cookie(state)};
}
type Pending={company_id:number;barber_id:number;user_id:number;verifier_ciphertext:string;expires_at:string;slug:string};
type Tokens={access_token?:string;refresh_token?:string;user_id?:number|string;expires_in?:number};
export const sellerMpCallbackRouter=new Hono<{Bindings:Env}>();
sellerMpCallbackRouter.get("/callback",async c=>{
 const response=(slug:string,result:"connected"|"failed")=>{
  c.header("Set-Cookie",cookie("",0));c.header("Cache-Control","no-store");
  return c.redirect(safeReturn(slug,result),303);
 };
 const callbackUrl=new URL(c.req.url);
 if(callbackUrl.searchParams.getAll("state").length!==1 ||
    callbackUrl.searchParams.getAll("code").length>1)
  return c.json({error:"Parâmetros de autorização inválidos."},400,noStore);
 const state=c.req.query("state")||"";
 const code=c.req.query("code")||"";
 const cookieHeader=c.req.header("cookie")||"";
 const cookieState=cookieHeader.split(";").map(s=>s.trim()).find(s=>s.startsWith(COOKIE+"="))?.slice(COOKIE.length+1)||"";
 if(!/^[a-f0-9]{64}$/.test(state)||state!==cookieState||!isEnabled(c.env))
  return c.json({error:"Autorização expirada ou inválida."},400,noStore);
 const hash=await sha256hex(state);
 const pending=await c.env.DB.prepare(`SELECT p.company_id,p.barber_id,p.user_id,p.verifier_ciphertext,p.expires_at,co.slug
 FROM seller_mp_oauth_pending p JOIN companies co ON co.id=p.company_id
 WHERE p.state_hash=?1 AND p.used_at IS NULL AND p.expires_at>?2`)
 .bind(hash,new Date().toISOString()).first<Pending>();
 if(!pending)return c.json({error:"Autorização expirada ou utilizada."},400,noStore);
 // Consumir o state ANTES da troca de tokens impede replay concorrente.
 const claimed=await c.env.DB.prepare(`UPDATE seller_mp_oauth_pending SET used_at=?1
 WHERE state_hash=?2 AND used_at IS NULL AND expires_at>?1`)
 .bind(new Date().toISOString(),hash).run();
 if(claimed.meta.changes!==1)return response(pending.slug,"failed");
 if(!code||code.length>1500)return response(pending.slug,"failed");
 const membership=await c.env.DB.prepare(`SELECT 1 AS valid FROM company_memberships m
 JOIN barbers b ON b.id=m.barber_id AND b.company_id=m.company_id
 WHERE m.company_id=?1 AND m.user_id=?2 AND m.barber_id=?3 AND m.role='barber'
 AND m.active=1 AND b.active=1`).bind(pending.company_id,pending.user_id,pending.barber_id).first();
 if(!membership)return response(pending.slug,"failed");
 const verifier=await decryptSecret(c.env,pending.verifier_ciphertext);
 if(!verifier)return response(pending.slug,"failed");
 try{
  const controller=new AbortController();
  const timer=setTimeout(()=>controller.abort(),12000);
  let tokenResponse:Response;
  try{tokenResponse=await fetch("https://api.mercadopago.com/oauth/token",{
   method:"POST",signal:controller.signal,
   headers:{"Content-Type":"application/json","Accept":"application/json"},
   body:JSON.stringify({grant_type:"authorization_code",client_id:c.env.MP_MARKETPLACE_CLIENT_ID,
    client_secret:c.env.MP_MARKETPLACE_CLIENT_SECRET,code,redirect_uri:appUrl(c.env),
    code_verifier:verifier})
  });}finally{clearTimeout(timer);}
  if(!tokenResponse.ok)return response(pending.slug,"failed");
  const tokens=await tokenResponse.json() as Tokens;
  const mpId=String(tokens.user_id||"");
  if(!/^\d{1,20}$/.test(mpId)||typeof tokens.access_token!=="string"||
    typeof tokens.refresh_token!=="string"||tokens.access_token.length<8||
    tokens.refresh_token.length<8||tokens.access_token.length>8192||tokens.refresh_token.length>8192||
    !Number.isSafeInteger(tokens.expires_in)||tokens.expires_in!<60||tokens.expires_in!>31536000)
    return response(pending.slug,"failed");
  const access=await encryptSecret(c.env,tokens.access_token);
  const refresh=await encryptSecret(c.env,tokens.refresh_token);
  const now=new Date().toISOString();
  await c.env.DB.prepare(`INSERT INTO seller_mp_accounts
   (company_id,barber_id,mp_user_id,access_ciphertext,refresh_ciphertext,expires_at,connected_by,connected_at,updated_at)
   VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?8)
   ON CONFLICT(company_id,barber_id) DO UPDATE SET
   mp_user_id=excluded.mp_user_id,access_ciphertext=excluded.access_ciphertext,
   refresh_ciphertext=excluded.refresh_ciphertext,expires_at=excluded.expires_at,
   connected_by=excluded.connected_by,connected_at=excluded.connected_at,updated_at=excluded.updated_at`)
   .bind(pending.company_id,pending.barber_id,mpId,access,refresh,
    new Date(Date.now()+tokens.expires_in*1000).toISOString(),pending.user_id,now).run();
  return response(pending.slug,"connected");
 }catch{
  // Não registrar tokens, authorization code, request body ou client_secret.
  return response(pending.slug,"failed");
 }
});
export { isEnabled as sellerOauthEnabled };
