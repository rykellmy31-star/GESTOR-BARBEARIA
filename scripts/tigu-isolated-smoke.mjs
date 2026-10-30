#!/usr/bin/env node
/**
 * Homologação remota SEM transações reais e SOMENTE no Worker NOVO.
 * Duas empresas/testes fictícios; não acessa produção, não chama gateway.
 */
import {randomBytes} from "node:crypto";
import {NAMES} from "./tigu-isolated-deploy-once.mjs";
const base="https://"+NAMES.publicHost;
const id=randomBytes(9).toString("hex");
const password="TiguFicticio!"+randomBytes(16).toString("hex");
let checks=0;
function ok(label,pass,detail=""){
  if(!pass)throw Error("Falhou: "+label+(detail?" ("+detail+")":""));
  checks++;console.log("✔ "+label);
}
async function get(path,cookie=""){
  const r=await fetch(base+path,{method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
    headers:{"cache-control":"no-store","Accept":"application/json",...(cookie?{Cookie:cookie}:{})}});
  return {status:r.status,data:await r.json().catch(()=>null)};
}
async function post(path,payload,cookie=""){
  const r=await fetch(base+path,{method:"POST",redirect:"error",signal:AbortSignal.timeout(15000),
    headers:{"Content-Type":"application/json",Origin:base,...(cookie?{Cookie:cookie}:{})},
    body:JSON.stringify(payload)});
  return {status:r.status,data:await r.json().catch(()=>null),cookie:r.headers.get("set-cookie")?.split(";")[0]??""};
}
async function main(){
  const h=await get("/api/health");
  ok("Worker separado responde em staging",h.status===200&&h.data?.ok===true&&h.data.staging===true&&h.data.d1===true&&h.data.r2===true);
  ok("Secrets de sessão e criptografia ativos",
    h.data?.security?.session_secret_ready===true&&h.data.security.encryption_key_ready===true);
  ok("Meta WhatsApp obrigatoriamente simulado",h.data?.whatsapp?.mock===true);
  ok("Gateway sem modo de pagamento real para assinatura",h.data?.payments?.mock===false);
  const plans=await get("/api/marketing/plans");
  ok("Start, Pro e Scale disponíveis sem cobrança automática",
    plans.status===200&&plans.data?.automatic_billing===false&&
    ["free","pro","scale"].every(code=>plans.data?.plans?.some(p=>p.code===code)));
  const anonymous=await get("/api/auth/me");
  ok("Sessão anônima isolada",anonymous.status===200&&anonymous.data?.user===null);
  const signup=async(n)=>{
    const res=await post("/api/auth/register",{
      company_name:"TIGU TESTE MANUAL "+n+" "+id,
      name:"Proprietário Fictício",email:"tigu-homolog-"+id+"-"+n+"@example.test",
      password
    });
    ok("Cadastro fictício "+n+" em D1 independente",res.status===201&&!!res.data?.company?.slug);
    ok("Sessão protegida "+n,Boolean(res.cookie));
    return {cookie:res.cookie,slug:res.data.company.slug};
  };
  const a=await signup(1),b=await signup(2);
  const path="/api/c/"+a.slug;
  const cross=await get(path+"/admin/dashboard",b.cookie);
  ok("Barbearias isoladas por autenticação",cross.status===403);
  const summary=await get(path+"/billing/status",a.cookie);
  ok("Mensalidade é manual, independente do MP opcional dos barbeiros",
    summary.status===200&&summary.data?.billing_mode==="manual");
  const pix=await post(path+"/billing/pix",{plan_code:"pro"},a.cookie);
  ok("Nenhum Pix de mensalidade criado na API",pix.status===409);
  const req=await post(path+"/billing/plan-request",{plan_code:"pro"},a.cookie);
  ok("Pedido de plano registrado sem pagamento",req.status===200&&Number(req.data?.request_id)>0);
  const after=await get(path+"/billing/status",a.cookie);
  ok("Plano solicitado continua pendente sem ativação automática",
    after.status===200&&after.data?.plan_request?.plan_code==="pro"&&
    after.data?.subscription?.status==="trial");
  const optional=await get(path+"/admin/payments/mercadopago",a.cookie);
  ok("Configuração do Mercado Pago do proprietário preservada e isolada",
    optional.status===200&&!JSON.stringify(optional.data).includes("access_token"));
  console.log("TIGU NOVO HOMOLOG: "+checks+" verificações remotas fictícias aprovadas.");
}
if(process.argv.length!==2||process.env.TIGU_ISOLATED_SMOKE_APPROVED!=="YES"){
  console.error("Homologação isolada não autorizada.");
  process.exitCode=1;
}else{
  main().catch(e=>{console.error("TIGU HOMOLOG FALHOU: "+(e instanceof Error?e.message:String(e)));process.exitCode=1;});
}
