import test from "node:test";
import assert from "node:assert/strict";
import {sanitizeWorkerError,findSafeTailErrors} from "./staging-diagnose-signup.mjs";
test("redige email, telefone, token e segredos do erro remoto",()=>{
 const text='D1_ERROR token: abc123xyzabc123 user@example.test telefone 5573999990000 Bearer xxxxxx';
 const safe=sanitizeWorkerError(text);
 assert.ok(safe.includes("D1_ERROR"));
 assert.ok(!safe.includes("user@example.test"));
 assert.ok(!safe.includes("5573999990000"));
 assert.ok(!safe.includes("abc123xyz"));
 assert.ok(!safe.includes("xxxxxx"));
});
test("extrai só logs de erro do POST de cadastro, ignora demais rotas e payloads",()=>{
 const events=[
  {event:{request:{method:"POST",url:"https://tigu-staging.example/api/auth/register"}},logs:[
   {level:"error",message:["D1_ERROR: no such table request_rate_limits"]},
   {level:"log",message:["ignore secret"]}],exceptions:[],outcome:"exception"},
  {event:{request:{method:"GET",url:"https://tigu-staging.example/api/health"}},logs:[
   {level:"error",message:["another secret"]}],outcome:"ok"},
 ].map(JSON.stringify).join("\n");
 const x=findSafeTailErrors(events);
 assert.ok(x.some(s=>s.includes("D1_ERROR")));
 assert.ok(x.some(s=>s.includes("exception")));
 assert.ok(!x.join(" ").includes("another secret"));
 assert.ok(!x.join(" ").includes("ignore secret"));
});
