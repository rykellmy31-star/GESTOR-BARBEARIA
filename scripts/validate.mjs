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
for (const script of ["validate.mjs","staging.mjs","staging-config.mjs","staging-config.test.mjs","ci-policy.test.mjs","staging-smoke.mjs","create-super.mjs"])
  run(process.execPath,["--check",join(root,"scripts",script)]);
run(process.execPath,["--test",join(root,"scripts/staging-config.test.mjs"),join(root,"scripts/ci-policy.test.mjs")]);

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
