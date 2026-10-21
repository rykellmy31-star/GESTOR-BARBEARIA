#!/usr/bin/env node
/** Mesmas verificações locais e no CI. Não publica, migra ou chama provedores. */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, copyFileSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dirname, "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command,args,cwd=root) => execFileSync(command,args,{cwd,stdio:"inherit"});

run(npm,["audit","--audit-level=moderate"]);
for (const script of ["validate.mjs","production-preflight.mjs","production-preflight.node.test.mjs","migrations-smoke.node.test.mjs","global-message-queue.node.test.mjs","platform-financial-settings.node.test.mjs","local-e2e.mjs","staging.mjs","staging-config.mjs","staging-config.test.mjs","ci-policy.test.mjs","staging-smoke.mjs","backup-evidence.mjs","backup-evidence.node.test.mjs","cloudflare-audit.mjs","cloudflare-audit.node.test.mjs","staging-provision.mjs","staging-provision.node.test.mjs","staging-deploy-ci.mjs","staging-deploy-ci.node.test.mjs","staging-d1-export-verify.mjs","staging-d1-export-verify.node.test.mjs","staging-auth-e2e.mjs","staging-auth-e2e.node.test.mjs","staging-d1-remote-restore.mjs","staging-d1-remote-restore.node.test.mjs","staging-r2-remote-restore.mjs","staging-r2-remote-restore.node.test.mjs","staging-update-ci.mjs","staging-update-ci.node.test.mjs","staging-booking-migrate-ci.mjs","staging-diagnose-signup.mjs","staging-diagnose-signup.node.test.mjs","create-super.mjs"])
  run(process.execPath,["--check",join(root,"scripts",script)]);
run(process.execPath,["--test",join(root,"scripts/staging-config.test.mjs"),join(root,"scripts/ci-policy.test.mjs"),join(root,"scripts/production-preflight.node.test.mjs"),join(root,"scripts/migrations-smoke.node.test.mjs"),join(root,"scripts/global-message-queue.node.test.mjs"),join(root,"scripts/platform-financial-settings.node.test.mjs"),join(root,"scripts/backup-evidence.node.test.mjs"),join(root,"scripts/cloudflare-audit.node.test.mjs"),join(root,"scripts/staging-provision.node.test.mjs"),join(root,"scripts/staging-deploy-ci.node.test.mjs"),join(root,"scripts/staging-d1-export-verify.node.test.mjs"),join(root,"scripts/staging-auth-e2e.node.test.mjs"),join(root,"scripts/staging-d1-remote-restore.node.test.mjs"),join(root,"scripts/staging-r2-remote-restore.node.test.mjs"),join(root,"scripts/staging-update-ci.node.test.mjs"),join(root,"scripts/staging-diagnose-signup.node.test.mjs")]);

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
