import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { writeEnvironment } from "../demos/missing-transformation/environment.ts";
import { engine, program, sandboxSkip, tempDir } from "./support.ts";

test("a missing transformation is identified exactly, with an oracle mined from the environment", { skip: sandboxSkip }, async () => {
  const dir = tempDir("reason");
  const env = writeEnvironment(16, dir);
  const e = await engine(dir, [env.programs]);
  const a = await e.analyseCompact(env.goal, env.base);
  assert.equal(a.status, "gap-found");
  assert.match(a.gaps[0].title, /^delimited\(;\).* -> ndjson/);
  assert.ok(a.gaps[0].oracles.includes("inverse-route"), "the archiver is exapted as an oracle");
  assert.ok(a.gaps[0].worthAttempting);
  assert.ok(a.rcx.plans >= 1, "RightClick X's type-level plan exists, and is not evidence of anything");
  assert.ok(e.universe.nodes().some((n) => n.status === "candidate-missing"));
});

test("when the route already exists, nothing is invented", { skip: sandboxSkip }, async () => {
  const dir = tempDir("reason");
  const programs = path.join(dir, "programs");
  program(programs, "shape", `if (args[0] === '--help') { console.log('usage: shape\\n\\nExample input:\\n  a,b\\n  1,2\\n'); process.exit(0); }
const t = fs.readFileSync(0, 'utf8').trim().split('\\n'); const h = t[0].split(','); if (h[0] !== 'a') { console.error('no'); process.exit(3); }
console.log(t.slice(1).map((l) => JSON.stringify({ a: Number(l.split(',')[0]) })).join('\\n'));`);
  program(programs, "sink", `if (args[0] === '--help') { console.log('usage: sink\\n\\nExample input:\\n  {"a":1}\\n'); process.exit(0); }
const t = fs.readFileSync(0, 'utf8').trim().split('\\n'); let s = 0; for (const l of t) { const o = JSON.parse(l); if (typeof o.a !== 'number') process.exit(3); s += o.a; } console.log('sum ' + s);`);
  const e = await engine(dir, [programs]);
  const a = await e.analyseCompact({ id: "g", intent: "sum it", have: { samples: [{ text: "a,b\n1,2\n3,4\n" }] }, want: { program: "sink" } }, dir);
  assert.equal(a.status, "achievable-composition");
  assert.deepEqual(a.route!.steps.map((s) => s.tool), ["cli:shape:mined", "cli:sink:mined"]);
  assert.equal(a.gaps.length, 0);
});

test("a documented option that bridges the gap is found before any code is written", { skip: sandboxSkip }, async () => {
  const dir = tempDir("reason");
  const programs = path.join(dir, "programs");
  program(programs, "sink", `if (args[0] === '--help') { console.log('usage: sink [--from FORMAT]\\n\\nOptions:\\n  --from FORMAT   input format, one of: json, csv\\n\\nExample input:\\n  {"a":1}\\n'); process.exit(0); }
const raw = fs.readFileSync(0, 'utf8').trim();
if (args.includes('--from=csv') || (args.includes('--from') && args[args.indexOf('--from') + 1] === 'csv')) { console.log('rows ' + raw.split('\\n').slice(1).length); process.exit(0); }
for (const l of raw.split('\\n')) { try { const o = JSON.parse(l); if (typeof o.a !== 'number') process.exit(3); } catch { process.exit(3); } } console.log('ok');`);
  const e = await engine(dir, [programs]);
  const a = await e.analyseCompact({ id: "g", intent: "load it", have: { samples: [{ text: "a,b\n1,2\n" }] }, want: { program: "sink" } }, dir);
  assert.equal(a.status, "achievable-existing");
  assert.match(a.summary, /documented option/);
});

test("a target that needs information the input does not carry is not constructible", { skip: sandboxSkip }, async () => {
  const dir = tempDir("reason");
  const programs = path.join(dir, "programs");
  program(programs, "sink", `if (args[0] === '--help') { console.log('usage: sink\\n\\nExample input:\\n  {"amount":1,"customer":"acme","vat_rate":0.2}\\n  {"amount":2,"customer":"zeta","vat_rate":0.1}\\n'); process.exit(0); }
for (const l of fs.readFileSync(0, 'utf8').trim().split('\\n')) { const o = JSON.parse(l); if (typeof o.amount !== 'number' || !o.customer || typeof o.vat_rate !== 'number') { console.error('incomplete'); process.exit(3); } } console.log('ok');`);
  const e = await engine(dir, [programs]);
  const a = await e.analyseCompact({ id: "g", intent: "load it", have: { samples: [{ text: "amount\n5\n6\n" }] }, want: { program: "sink" } }, dir);
  assert.equal(a.status, "not-constructible");
  assert.ok(a.limitations.join(" ").includes("customer"));
});

test("a gap with nothing that could check values is reported as unverifiable", { skip: sandboxSkip }, async () => {
  const dir = tempDir("reason");
  const programs = path.join(dir, "programs");
  program(programs, "sink", `if (args[0] === '--help') { console.log('usage: sink\\n\\nExample input:\\n  {"amount":1}\\n'); process.exit(0); }
for (const l of fs.readFileSync(0, 'utf8').trim().split('\\n')) { const o = JSON.parse(l); if (typeof o.amount !== 'number') process.exit(3); } console.log('ok');`);
  const e = await engine(dir, [programs]);
  const a = await e.analyseCompact({ id: "g", intent: "load it", have: { samples: [{ text: "amount\n5\n6\n" }] }, want: { program: "sink" } }, dir);
  assert.equal(a.status, "unverifiable");
});

test("an outcome that is not stated is reported as underspecified, with what is needed", async () => {
  const dir = tempDir("reason");
  fs.mkdirSync(path.join(dir, "p"));
  const e = await engine(dir, [path.join(dir, "p")]);
  const a = await e.analyseCompact({ id: "g", intent: "something", want: {} }, dir);
  assert.equal(a.status, "underspecified");
  assert.ok(a.questions.length >= 2);
});
