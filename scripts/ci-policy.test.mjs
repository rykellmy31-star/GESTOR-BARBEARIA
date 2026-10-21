import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const content = workflow.replace(/^\s*#.*$/gm, "");
const events = content.split(/^on:\s*$/m)[1]?.split(/^permissions:/m)[0];

test("Actions: eventos permitidos apenas na branch de auditoria, PR para main e manual", () => {
  assert.ok(events, "Declaracao de eventos obrigatoria");
  const keys = [...events.matchAll(/^  ([a-z_]+):/gm)].map(m => m[1]);
  assert.deepEqual(keys, ["push", "pull_request", "workflow_dispatch"]);
  assert.match(events, /^  push:\s*\n    branches:\s*\n      - audit\/tigu-primeira-validacao\s*$/m);
  assert.match(events, /^  pull_request:\s*\n    branches:\s*\n      - main\s*$/m);
  assert.doesNotMatch(events, /^  (schedule|workflow_run|repository_dispatch|pull_request_target):/m);
});

test("Actions: permissao de leitura e validacao sem deploy ou migracoes remotas", () => {
  assert.match(content, /^permissions:\s*\n  contents: read\s*$/m);
  assert.match(content, /^  verificar:\s*$/m);
  assert.match(content, /run: npm ci/);
  assert.match(content, /run: npm run validate/);
  assert.doesNotMatch(content, /run:\s*[^\n]*(?:wrangler deploy|--remote|staging:deploy|npm run deploy)/i);
  assert.match(content, /run: node scripts\/local-e2e\.mjs/);

});
