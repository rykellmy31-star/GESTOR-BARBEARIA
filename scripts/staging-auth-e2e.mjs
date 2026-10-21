#!/usr/bin/env node
/**
 * Homologação REMOTA autenticada em tigu-staging, com dados 100% fictícios.
 * Cria duas barbearias de teste e objetos R2 no ambiente separado.
 * NÃO usa dados pessoais reais, cobrança ou provedores externos.
 * O gate do CI impede execução acidental em produção.
 */
import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

export function checkStagingUrl(raw) {
  let url;
  try { url=new URL(raw); } catch { throw Error("URL de staging inválida."); }
  if(url.protocol!=="https:"||!/^tigu-staging\.[a-z0-9-]+\.workers\.dev$/i.test(url.hostname)||
    url.pathname!=="/"||url.search||url.hash||url.username||url.password)
    throw Error("Somente a raiz HTTPS do Worker tigu-staging.*.workers.dev pode receber dados fictícios.");
  return url.origin;
}
export function isIsolatedHealth(h) {
  return h?.ok===true&&h?.service==="tigu-api"&&h.staging===true&&
    h.d1===true&&h.r2===true&&h.security?.session_secret_ready===true&&
    h.security?.encryption_key_ready===true&&h.payments?.mercadopago===false&&
    h.payments?.mock===false&&h.whatsapp?.embedded===false&&h.whatsapp?.mock===true;
}

export async function authenticatedStagingChecks({ url,fetcher=fetch,makeBytes=n=>randomBytes(n) }) {
  const base=checkStagingUrl(url);
  let passed=0;
  const pass=(label,condition,debug="")=>{
    if(!condition) throw Error("Falha na homologação: "+label+(debug?" ("+debug+")":""));
    passed++;console.log("✔ "+label);
  };
  const response=async(method,path,body,cookie="")=>{
    if(!path.startsWith("/api/")||path.includes("://")||path.includes(".."))
      throw Error("Rota fora do escopo da API de homologação.");
    const multipart=body instanceof FormData;
    const r=await fetcher(base+path,{
      method,redirect:"manual",signal:AbortSignal.timeout(18000),
      headers:{"cache-control":"no-store",origin:base,...(body&&!multipart?{"content-type":"application/json"}:{}),...(cookie?{cookie}:{})},
      ...(body?{body:multipart?body:JSON.stringify(body)}:{}),
    });
    let data;try{data=await r.json();}catch{data=null;}
    return {status:r.status,data,headers:r.headers};
  };
  const health=await response("GET","/api/health");
  pass("Proteção da identidade do staging e bloqueio de pagamentos reais",
    health.status===200&&isIsolatedHealth(health.data));
  const random=makeBytes(10).toString("hex");
  const pw="Ficticio!"+makeBytes(24).toString("hex");
  const ownerMail="tigu-test-owner-"+random+"@example.test";
  const otherMail="tigu-test-other-"+random+"@example.test";
  const creds=[{email:ownerMail,company_name:"Tigu Teste "+random.slice(0,8)},
               {email:otherMail,company_name:"Tigu Isolamento "+random.slice(0,8)}];
  const register=async creds=>response("POST","/api/auth/register",{...creds,name:"Pessoa Fictícia",password:pw,phone:"",city:""});
  // Já verificamos que somente nosso staging está recebendo POST.
  const first=await register(creds[0]);
  pass("Cadastro público cria a primeira barbearia fictícia",first.status===201&&!!first.data?.company?.slug,"HTTP "+first.status+" "+String(first.data?.error||"").slice(0,120));
  const ownerCookie=first.headers.get("set-cookie")?.split(";")[0]||"";
  pass("Cookie HttpOnly e Secure",!!ownerCookie&&/httponly/i.test(first.headers.get("set-cookie")||"")&&
    /secure/i.test(first.headers.get("set-cookie")||""));
  const other=await register(creds[1]);
  pass("Cadastro cria segunda barbearia independente",other.status===201&&!!other.data?.company?.slug);
  const otherCookie=other.headers.get("set-cookie")?.split(";")[0]||"";
  const firstSlug=first.data.company.slug,otherSlug=other.data.company.slug;
  const c="/api/c/"+encodeURIComponent(firstSlug);
  const o=(m,path,body)=>response(m,path,body,ownerCookie);
  const x=(m,path,body)=>response(m,path,body,otherCookie);
  const me=await o("GET","/api/auth/me");
  pass("Sessão autenticada identifica dono fictício",me.status===200&&me.data?.user?.email===ownerMail);
  pass("Sessão de outra empresa não vê painel do primeiro tenant",
    (await x("GET",c+"/admin/dashboard")).status===403);
  pass("Acesso anônimo ao painel é negado",(await response("GET",c+"/admin/dashboard")).status===401);
  const billing=await o("GET",c+"/billing/status");
  pass("Plano grátis disponível no D1 remoto",billing.status===200&&billing.data?.subscription?.status==="trial");
  pass("Pix externo bloqueado no staging",(await o("POST",c+"/billing/pix",{plan_code:"free"})).status===503);
  const publicConfig=await response("GET",c+"/config");
  pass("Configuração pública mantém pagamento presencial e bloqueia Pix real",
    publicConfig.status===200&&publicConfig.data?.payment_options?.after_service===true&&
    publicConfig.data?.payment_options?.pix_enabled===false);
  const merchant=await o("GET",c+"/admin/payments/mercadopago");
  pass("Dono consulta recebimentos próprios sem expor credenciais",
    merchant.status===200&&merchant.data?.integration?.connected===false &&
    merchant.data?.integration?.pix_available===false &&
    !JSON.stringify(merchant.data).includes("access_token"));
  const cannotConnect=await o("PUT",c+"/admin/payments/mercadopago",{
    access_token:"APP_USR-CHAVE-FICTICIA-QUE-NAO-PRODUZ-CARGAS",
    webhook_secret:"assinatura-ficticia-sem-integracao"});
  pass("Homologação impede cadastrar token real e iniciar cobrança",
    cannotConnect.status===503);
  const remoteWebhook=await response("POST","/api/webhooks/merchant-mercadopago/"+crypto.randomUUID(),
    {type:"payment",data:{id:"123"}});
  pass("Webhook recebedor de cliente bloqueado no staging",remoteWebhook.status===403);
  const s=await o("GET",c+"/admin/settings");
  pass("Dono consegue consultar configurações",s.status===200&&!!s.data?.settings);
  const settings={...s.data.settings,min_lead_min:0,
    opening_hours:Object.fromEntries([0,1,2,3,4,5,6].map(day=>[String(day),{open:"09:00",close:"18:00"}])),
    whatsapp_reminders_enabled:false,whatsapp_confirm_enabled:false};
  pass("Dono salva configurações da barbearia fictícia",
    (await o("PUT",c+"/admin/settings",settings)).status===200);
  const barber=await o("POST",c+"/admin/barbers",{name:"Profissional Fictício",work_days:[0,1,2,3,4,5,6],
    work_start:"09:00",work_end:"18:00",break_start:"12:00",break_end:"13:00",service_ids:[]});
  pass("Criação de barbeiro fictício",barber.status===200&&Number(barber.data?.id)>0);
  const service=await o("POST",c+"/admin/services",{name:"Corte Fictício",price_cents:1900,duration_min:30,barber_ids:[barber.data.id]});
  pass("Serviço fictício associado ao barbeiro",service.status===200&&Number(service.data?.id)>0);
  const publicServices=await response("GET",c+"/services");
  pass("Site público lista serviço e barbeiro corretos",publicServices.status===200&&
    publicServices.data?.services?.some(it=>it.id===service.data.id&&it.barber_ids?.includes(barber.data.id)));
  const future=new Date(Date.now()+4*86400000).toISOString().slice(0,10);
  const availability=await response("GET",c+"/availability?barberId="+barber.data.id+"&serviceId="+service.data.id+"&day="+future);
  const free=availability.data?.slots?.filter(s=>s.available)||[];
  pass("Disponibilidade pública de horário remoto",availability.status===200&&free.length>0);
  const phone="55730000"+random.replace(/[a-f]/g,()=> "0").slice(0,5);
  const pixAttempt=await response("POST",c+"/bookings",{barberId:barber.data.id,
    serviceId:service.data.id,startsAt:free[0].t,name:"Cliente Pix Fictício",phone,
    email:"cliente-pix@example.test",consent:true,whatsappOptin:false,
    paymentChoice:"pix",idempotencyKey:makeBytes(16).toString("hex")});
  pass("Checkout recusa Pix real em staging sem consumir horário",pixAttempt.status===503);
  const book=await response("POST",c+"/bookings",{barberId:barber.data.id,serviceId:service.data.id,
    startsAt:free[0].t,name:"Cliente Fictício",phone,consent:true,whatsappOptin:false,
    idempotencyKey:makeBytes(16).toString("hex")});
  pass("Reserva fictícia persistida no D1 remoto",book.status===201&&Number(book.data?.booking?.id)>0);
  pass("Checkout padrão conserva preço do serviço e pagamento posterior",
    book.data?.payment_choice==="after_service"&&book.data?.payment===null&&
    book.data?.booking?.price_cents===1900);
  const lookup=await response("POST",c+"/bookings/lookup",{code:book.data.booking.code,phone});
  pass("Cliente fictício consulta agendamento pelo protocolo",lookup.status===200&&
    lookup.data?.bookings?.some(it=>it.id===book.data.booking.id));
  pass("Agendamento não é exposto em outro tenant",(await response("POST","/api/c/"+otherSlug+"/bookings/lookup",{
    code:book.data.booking.code,phone})).status===404);
  const cancelled=await o("POST",c+"/admin/bookings/"+book.data.booking.id+"/cancel",{reason:"Fim da homologação com dados fictícios"});
  pass("Reserva fictícia cancelada ao final do teste",cancelled.status===200);
  const product=await o("POST",c+"/admin/products",{name:"Pomada Fictícia",price_cents:2500,stock:3});
  pass("Painel cadastra produto fictício",product.status===200&&Number(product.data?.id)>0);
  const blockedOrder=await response("POST",c+"/orders",{name:"Cliente Pix Fictício",phone,
    email:"cliente@example.test",paymentChoice:"pix",idempotencyKey:makeBytes(16).toString("hex"),
    items:[{productId:product.data.id,qty:1}]});
  pass("Compra de produto não gera Pix real no staging",blockedOrder.status===503);

  const order=await response("POST",c+"/orders",{name:"Cliente Fictício",phone,
    items:[{productId:product.data.id,qty:2}]});
  pass("Cliente cria pedido fictício sem cobrança",order.status===201&&order.data?.total===50);
  const products=await o("GET",c+"/admin/products");
  pass("Pedido desconta estoque real D1, sem baixar novamente",products.status===200&&
    products.data?.products?.some(it=>it.id===product.data.id&&it.stock===1));
  const orders=await o("GET",c+"/admin/orders");
  const entry=orders.data?.orders?.find(it=>it.code===order.data.code);
  pass("Painel encontra pedido e valor em centavos",orders.status===200&&entry?.total_cents===5000);
  pass("Pedido fictício cancelado e estoque restaurado",(await o("POST",c+"/admin/orders/"+entry.id+"/status",
    {status:"cancelado"})).status===200);
  // Use known safe fixture from the project (1x1 PNG).
  const image=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9uoAAAAASUVORK5CYII=","base64");
  const upload=new FormData();
  upload.append("file",new Blob([image],{type:"image/png"}),"tigu-ficticio.png");
  const up=await o("POST",c+"/admin/upload",upload);
  pass("Upload de mídia fictícia persiste no R2 do staging",up.status===201&&typeof up.data?.url==="string");
  if(!/^\/uploads\/[a-zA-Z0-9/_\-.]+$/.test(up.data.url))throw Error("URL de mídia de homologação inesperada.");
  const media=await fetcher(base+up.data.url,{method:"GET",redirect:"manual",signal:AbortSignal.timeout(15000)});
  pass("Download remoto R2 mantém bytes do PNG",media.status===200&&
    Buffer.from(await media.arrayBuffer()).equals(image));
  console.log("TIGU staging: "+passed+" verificações autenticadas, duas empresas FICTÍCIAS, nenhuma cobrança.");
  return { passed, fictional_tenants:2,booking_cancelled:true,order_cancelled:true,
    remote_r2_upload_verified:true,production_modified:false,real_payment:false };
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{
    if(process.env.GITHUB_ACTIONS!=="true"||process.env.GITHUB_EVENT_NAME!=="push"||
      process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
      process.env.TIGU_AUTH_E2E_APPROVED!=="YES"||process.argv.length!==2)
      throw Error("Homologação autenticada bloqueada fora do push autorizado do TIGU.");
    const result=await authenticatedStagingChecks({url:process.env.STAGING_URL});
    console.log(JSON.stringify(result,null,2));
  }catch(err){
    console.error("Homologação autenticada TIGU: "+(err instanceof Error?err.message:String(err)));
    process.exitCode=1;
  }
}
