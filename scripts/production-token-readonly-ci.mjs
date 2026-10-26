#!/usr/bin/env node
/** Leitura de metadados, sem deploy, sem usar D1 SQL, sem revelar token.
 * Executar apenas pelo GitHub Actions com gatilho manual por commit. */
const token=process.env.CLOUDFLARE_PRODUCTION_TOKEN;
const account=process.env.CLOUDFLARE_ACCOUNT_ID;
const accountPattern=/^[a-f0-9]{32}$/i;
async function main() {
 if(process.env.GITHUB_ACTIONS!=="true"||
    process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
    process.env.GITHUB_EVENT_NAME!=="push"||
    process.env.GITHUB_HEAD_REF)throw Error("Execução GitHub não autorizada.");
 if(!token||token.length<15)throw Error("Segredo CLOUDFLARE_PRODUCTION_TOKEN indisponível.");
 if(!accountPattern.test(account||""))throw Error("CLOUDFLARE_ACCOUNT_ID inválido.");
 const url="https://api.cloudflare.com/client/v4/accounts/"+account;
 const paths=[
  ["/workers/scripts","Worker"],
  ["/d1/database?name=tigu-production-db","Banco D1"],
  ["/r2/buckets?name_contains=tigu-production-media","R2"]
 ];
 const facts={};
 for(const [path,name] of paths) {
  const response=await fetch(url+path,{
   method:"GET",redirect:"error",signal:AbortSignal.timeout(15000),
   headers:{Authorization:"Bearer "+token,Accept:"application/json"}
  });
  if(!response.ok)throw Error(name+": autorização GET falhou (HTTP "+response.status+").");
  const data=await response.json();
  if(data?.success!==true)throw Error(name+": Cloudflare negou inventário.");
  if(path==="/workers/scripts"){
   if(!Array.isArray(data.result))throw Error("Formato inesperado de Worker.");
   facts.production_worker_exists=data.result.some(x=>x?.id==="tigu-production");
  } else if(path.startsWith("/d1/")){
   if(!Array.isArray(data.result))throw Error("Formato inesperado D1.");
   facts.production_d1_exists=data.result.some(x=>x?.name==="tigu-production-db");
  } else {
   if(!Array.isArray(data.result?.buckets))throw Error("Formato inesperado R2.");
   facts.production_r2_exists=data.result.buckets.some(x=>x?.name==="tigu-production-media");
  }
 }
 console.log("TIGU_PRODUCTION_TOKEN_GET_OK",JSON.stringify(facts));
 console.log("Token existe e permitiu leitura dos recursos. Permissões de escrita ainda não testadas.");
}
main().catch(e=>{console.error("TIGU_PRODUCTION_TOKEN_CHECK:",e instanceof Error?e.message:"falha inesperada");process.exitCode=1});
