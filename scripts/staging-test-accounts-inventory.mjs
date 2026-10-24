#!/usr/bin/env node
// Inventário estritamente read-only do TIGU staging. Nenhum nome/email é exibido.
import { readFileSync } from "node:fs";
const event=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH||"/dev/null","utf8"));
if(process.env.GITHUB_ACTIONS!=="true"||process.env.GITHUB_EVENT_NAME!=="push"||
  process.env.GITHUB_REF!=="refs/heads/audit/tigu-primeira-validacao"||
  process.env.GITHUB_REPOSITORY!=="rykellmy31-star/GESTOR-BARBEARIA"||
  event.head_commit?.message!=="TIGU_AUDIT_TEST_ACCOUNTS_ONCE")
  throw Error("Gatilho de inventário inválido.");
const token=process.env.CLOUDFLARE_STAGING_TOKEN||"";
const account=process.env.CLOUDFLARE_ACCOUNT_ID||"";
if(token.length<15||!/^[a-f0-9]{32}$/i.test(account))throw Error("Credenciais de staging ausentes.");
const base="https://api.cloudflare.com/client/v4/accounts/"+account;
const req=async(method,path,payload)=>{
  const res=await fetch(base+path,{method,redirect:"error",signal:AbortSignal.timeout(25000),
    headers:{Authorization:"Bearer "+token,Accept:"application/json",...(payload?{"Content-Type":"application/json"}:{})},
    ...(payload?{body:JSON.stringify(payload)}:{})});
  if(!res.ok)throw Error("Inventário Cloudflare recusado (HTTP "+res.status+").");
  const j=await res.json();if(j.success!==true)throw Error("Cloudflare recusou inventário.");
  return j.result;
};
const [dbs,workers]=await Promise.all([
  req("GET","/d1/database?name=tigu-staging-db"),req("GET","/workers/scripts")
]);
const db=Array.isArray(dbs)?dbs.filter(d=>d.name==="tigu-staging-db"):[];
if(db.length!==1||!Array.isArray(workers)||!workers.some(w=>w.id==="tigu-staging"))
  throw Error("Destino de staging não verificado.");
const sqls=[
  ["test_users", "SELECT COUNT(*) AS n FROM users WHERE platform_role='user' AND (email GLOB 'tigu-test-owner-*@example.test' OR email GLOB 'tigu-test-other-*@example.test')"],
  ["test_companies", "SELECT COUNT(*) AS n FROM companies WHERE (name GLOB 'Tigu Teste *' OR name GLOB 'Tigu Isolamento *') AND EXISTS (SELECT 1 FROM company_memberships m JOIN users u ON u.id=m.user_id WHERE m.company_id=companies.id AND (u.email GLOB 'tigu-test-owner-*@example.test' OR u.email GLOB 'tigu-test-other-*@example.test'))"],
  ["marked_demo_companies", "SELECT COUNT(*) AS n FROM companies WHERE demo=1"],
  ["marked_demo_users", "SELECT COUNT(*) AS n FROM users WHERE demo=1 AND platform_role='user'"],
  ["other_users", "SELECT COUNT(*) AS n FROM users WHERE platform_role='user' AND NOT (email GLOB 'tigu-test-owner-*@example.test' OR email GLOB 'tigu-test-other-*@example.test')"],
  ["superadmins", "SELECT COUNT(*) AS n FROM users WHERE platform_role='superadmin' AND active=1"],
];
const out={};
for(const [label,sql] of sqls){
 const res=await req("POST","/d1/database/"+db[0].uuid+"/query",{sql,params:[]});
 if(!Array.isArray(res)||res.length!==1||res[0].success!==true)
   throw Error("D1 recusou inventário de "+label);
 out[label]=Number(res[0].results?.[0]?.n);
}
console.log("TIGU_STAGING_TEST_ACCOUNTS_READONLY="+JSON.stringify(out));
console.log("Nenhuma conta, barbearia, pagamento ou arquivo foi alterado.");
