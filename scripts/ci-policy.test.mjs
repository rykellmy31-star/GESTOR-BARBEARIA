import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("Actions não pode adicionar eventos automáticos à validação Tigu",()=>{
  const workflow=readFileSync(new URL("../.github/workflows/ci.yml",import.meta.url),"utf8");
  const content=workflow.replace(/^\s*#.*$/gm,"");
  const events=content.split(/^on:\s*$/m)[1]?.split(/^permissions:/m)[0];
  assert.ok(events,"Declaração explícita de eventos é obrigatória");
  const keys=[...events.matchAll(/^  ([a-z_]+):/gm)].map(m=>m[1]);
  assert.deepEqual(keys,["workflow_dispatch"]);
  assert.doesNotMatch(events,/^\s*(push|pull_request|schedule|workflow_run|repository_dispatch):/m);
  assert.match(content,/^  verificar:/m);
  assert.match(content,/run: npm run validate/);
});
