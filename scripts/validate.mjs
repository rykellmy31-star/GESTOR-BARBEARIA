#!/usr/bin/env node
/** Mesmas verificações locais e no CI. Não publica, migra ou chama provedores. */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command,args,cwd=root) => execFileSync(command,args,{cwd,stdio:"inherit"});

// Evita travamento do CI quando o registro npm está indisponível.
// Vulnerabilidades identificadas continuam bloqueando a validação.
const audit=spawnSync(npm,[
  "audit","--audit-level=moderate","--json",
  "--fetch-retries=0","--fetch-timeout=12000"
],{cwd:root,encoding:"utf8",timeout:30000,maxBuffer:4*1024*1024});
const auditJson=(()=>{
  try{return JSON.parse(audit.stdout||"{}");}catch{return null;}
})();
const counts=auditJson?.metadata?.vulnerabilities;
const criticalOrModerate=counts &&
  ["moderate","high","critical"].some(k=>Number(counts[k]||0)>0);
if(criticalOrModerate)
  throw Error("Auditoria encontrou dependências com vulnerabilidades moderadas ou superiores. Publicação bloqueada.");
if(audit.error || audit.status!==0) {
  const detail=[audit.stdout,audit.stderr,audit.error?.message,
    auditJson?.error?.code,auditJson?.error?.summary,auditJson?.error?.detail].filter(Boolean).join("\n");
  const networkOutage=/(?:503|Service Unavailable|network timeout|EAI_AGAIN|ENOTFOUND|ETIMEDOUT|ECONNRESET|FETCH_ERROR|ERR_SOCKET_TIMEOUT)/i.test(detail);
  const retiredAuditEndpoint=/This endpoint is being retired/i.test(detail) &&
    /Invalid package tree/i.test(detail);
  if(process.env.TIGU_STAGING_AUDIT_OUTAGE_TOLERATED==="YES" && (networkOutage || retiredAuditEndpoint)) {
    console.warn("ATENÇÃO: serviço de auditoria npm indisponível ou endpoint obsoleto. Auditoria de dependências INCONCLUSIVA; somente testes locais de staging prosseguem.");
  }else{
    if(audit.stdout)process.stderr.write(audit.stdout.slice(-4000)+"\n");
    if(audit.stderr)process.stderr.write(audit.stderr.slice(-4000)+"\n");
    throw Error("Auditoria de dependências falhou ou expirou; operação não aprovada.");
  }
}else{
  console.log("Auditoria de dependências sem vulnerabilidades moderadas, altas ou críticas.");
}
for (const script of ["validate.mjs","production-preflight.mjs","production-preflight.node.test.mjs","production-inventory-readonly.mjs","production-inventory-readonly.node.test.mjs","migrations-smoke.node.test.mjs","global-message-queue.node.test.mjs","platform-financial-settings.node.test.mjs","local-e2e.mjs","staging.mjs","staging-config.mjs","staging-config.test.mjs","ci-policy.test.mjs","staging-smoke.mjs","backup-evidence.mjs","backup-evidence.node.test.mjs","cloudflare-audit.mjs","cloudflare-audit.node.test.mjs","staging-provision.mjs","staging-provision.node.test.mjs","staging-deploy-ci.mjs","staging-deploy-ci.node.test.mjs","staging-d1-export-verify.mjs","staging-d1-export-verify.node.test.mjs","staging-auth-e2e.mjs","staging-auth-e2e.node.test.mjs","staging-d1-remote-restore.mjs","staging-d1-remote-restore.node.test.mjs","staging-d1-restore-readonly-compare.mjs","staging-d1-restore-readonly-compare.node.test.mjs","staging-r2-remote-restore.mjs","staging-r2-remote-restore.node.test.mjs","staging-r2-inventory-readonly.mjs","staging-r2-inventory-readonly.node.test.mjs","staging-r2-full-recovery-ci.mjs","staging-r2-full-recovery-ci.node.test.mjs","staging-update-ci.mjs","staging-update-ci.node.test.mjs","staging-booking-migrate-ci.mjs","staging-diagnose-signup.mjs","staging-diagnose-signup.node.test.mjs","create-super.mjs"])
  run(process.execPath,["--check",join(root,"scripts",script)]);
run(process.execPath,["--test",join(root,"scripts/staging-config.test.mjs"),join(root,"scripts/ci-policy.test.mjs"),join(root,"scripts/production-preflight.node.test.mjs"),join(root,"scripts/production-inventory-readonly.node.test.mjs"),join(root,"scripts/migrations-smoke.node.test.mjs"),join(root,"scripts/global-message-queue.node.test.mjs"),join(root,"scripts/platform-financial-settings.node.test.mjs"),join(root,"scripts/backup-evidence.node.test.mjs"),join(root,"scripts/cloudflare-audit.node.test.mjs"),join(root,"scripts/staging-provision.node.test.mjs"),join(root,"scripts/staging-deploy-ci.node.test.mjs"),join(root,"scripts/staging-d1-export-verify.node.test.mjs"),join(root,"scripts/staging-auth-e2e.node.test.mjs"),join(root,"scripts/staging-d1-remote-restore.node.test.mjs"),join(root,"scripts/staging-d1-restore-readonly-compare.node.test.mjs"),join(root,"scripts/staging-r2-remote-restore.node.test.mjs"),join(root,"scripts/staging-r2-inventory-readonly.node.test.mjs"),join(root,"scripts/staging-r2-full-recovery-ci.node.test.mjs"),join(root,"scripts/staging-update-ci.node.test.mjs"),join(root,"scripts/staging-diagnose-signup.node.test.mjs")]);

// Exercita os comandos de preparação/validação sem sobrescrever configurações locais.
const staging = mkdtempSync(join(tmpdir(),"tigu-validation-"));
try {
  for (const file of ["wrangler.jsonc","wrangler.staging.template.jsonc"])
    copyFileSync(join(root,file),join(staging,file));
  run(process.execPath,[join(root,"scripts/staging.mjs"),"prepare","--database-id","00000000-0000-4000-8000-000000000001"],staging);
  run(process.execPath,[join(root,"scripts/staging.mjs"),"validate"],staging);
} finally {
  rmSync(staging,{recursive:true,force:true});
}

// O build executa tsc -b, validando app, API, testes e configuração Node uma vez.
run(npm,["run","build"]);
if (!readFileSync(join(root,"dist/index.html"),"utf8").includes('<meta name="referrer" content="no-referrer"'))
  throw new Error("Política de privacidade do referrer ausente do HTML compilado.");
const assets = join(root,"dist/assets");
const compiled = readdirSync(assets).filter(f=>f.endsWith(".js"))
  .map(f=>readFileSync(join(assets,f),"utf8")).join("\n");
for (const label of [
  "Sistema desenvolvido por","Carlos Rykellmy Santos Correia",
  "Filtrar agendamentos por barbeiro","Profissional:","Prévia sem API conectada",
  "Planos e valores da página de vendas","Solicitar atendimento comercial",
  "Enviar solicitação de atendimento","Interessados nos planos","Privacidade dos contatos",
  "Excluir dados do contato","Mensalidades Pix","Esta tela é somente de consulta",
  "O prazo de armazenamento ainda não está disponível",
]) {
  if (!compiled.includes(label)) throw new Error(`Texto obrigatório ausente do build: ${label}`);
}
run(npm,["test"]);
console.log("✔ Validação completa aprovada. Nenhum deploy ou recurso remoto foi alterado.");
