// Negative controls for the execution boundary and the authority model.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { writeEnvironment } from "../demos/missing-transformation/environment.ts";
import { DockerBackend, openBackend, selfTest } from "../packages/execution/index.ts";
import { assertGoalSafe } from "../packages/protocol/engine.ts";
import { dispatch, TOOLS } from "../packages/protocol/mcp.ts";
import { RCX_TOOLS } from "../packages/rcx-adapter/index.ts";
import { Refused } from "../packages/shared/index.ts";
import { Scripted } from "../packages/model-adapters/index.ts";
import { createHandler } from "../apps/server/index.ts";
import { engine, sandboxSkip, tempDir } from "./support.ts";

const CLI = path.join(import.meta.dirname, "../apps/cli/exapt.ts");
const hostile = (body: string) => `export async function transform(input) { ${body} }`;

test("the boundary contains every attack in the self-test", { skip: sandboxSkip }, async () => {
  const r = await selfTest(new DockerBackend());
  assert.ok(r.ok, r.failures.join("; "));
  assert.ok(r.checks.length >= 10);
});

const attacks: Array<[string, string, (r: Awaited<ReturnType<DockerBackend["run"]>>) => boolean]> = [
  ["cannot resolve or reach the host", `try { const dns = await import('node:dns/promises'); await dns.lookup('host.docker.internal'); return 'resolved'; } catch { return 'denied'; }`, (r) => r.output === "denied"],
  ["cannot reach the Docker socket", `const net = await import('node:net'); return await new Promise((ok) => { const s = net.connect('/var/run/docker.sock'); s.on('connect', () => ok('connected')); s.on('error', () => ok('denied')); });`, (r) => r.output === "denied"],
  ["cannot execute from its scratch space", `const fs = await import('node:fs'); const { spawnSync } = await import('node:child_process'); fs.writeFileSync('/tmp/x.sh', '#!/bin/sh\\necho pwned'); fs.chmodSync('/tmp/x.sh', 0o755); return spawnSync('/tmp/x.sh').stdout?.toString() || 'denied';`, (r) => r.output === "denied"],
  ["cannot fill the disk", `const fs = await import('node:fs'); try { const b = Buffer.alloc(1024 * 1024); for (let i = 0; i < 128; i++) fs.appendFileSync('/tmp/big', b); return 'filled'; } catch { return 'limited'; }`, (r) => r.output === "limited"],
  ["cannot read another program's environment", `const fs = await import('node:fs'); return fs.readFileSync('/proc/1/environ').toString().includes('KEY') ? 'leak' : 'clean';`, (r) => r.output !== "leak"],
];
for (const [name, body, ok] of attacks) {
  test(`generated code ${name}`, { skip: sandboxSkip }, async () => {
    const r = await new DockerBackend().spawnRun({ source: hostile(body), input: "" });
    assert.ok(ok(r), `${r.status} ${r.output} ${r.error}`);
  });
}

test("no container outlives a timed-out run", { skip: sandboxSkip }, async () => {
  await new DockerBackend().spawnRun({ source: hostile("for (;;) {}"), input: "", limits: { timeoutMs: 800 } });
  await new Promise((r) => setTimeout(r, 1200));
  const left = spawnSync("docker", ["ps", "-q", "--filter", "label=exapt.generated=1"], { encoding: "utf8" }).stdout.trim();
  assert.equal(left, "");
});

test("without Docker, generated code is refused, not run some weaker way", () => {
  const dir = tempDir("sec");
  const r = spawnSync(process.execPath, [CLI, "demo", "1"], { env: { PATH: "/nonexistent", HOME: dir, EXAPT_HOME: dir }, encoding: "utf8", timeout: 20000, cwd: dir });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /cannot run here/);
});

test("a weaker sandbox cannot be selected", () => {
  assert.throws(() => openBackend({ EXAPT_SANDBOX: "vm" }), Refused);
  assert.throws(() => openBackend({ EXAPT_SANDBOX: "none" }), Refused);
});

test("no agent-facing argument can widen authority", () => {
  const banned = /sandbox|network|authori[sz]e|allow|approve|permission|credential|programs|policy|limit[a-z]*memory/i;
  for (const tool of TOOLS) for (const key of Object.keys(tool.inputSchema.properties)) if (key !== "limit") assert.ok(!banned.test(key), `${tool.name}.${key}`);
  assert.ok(TOOLS.length <= 14, "a fixed small surface");
  assert.ok(JSON.stringify(TOOLS).length <= JSON.stringify(RCX_TOOLS).length, "no heavier on a context window than the 13-tool surface it inherits");
});

test("agent-supplied goals cannot read files by path", () => {
  const goal = { id: "g", intent: "x", have: { samples: [{ path: "/etc/passwd" }] }, want: { program: "p" } };
  assert.throws(() => assertGoalSafe(goal, []), Refused);
  assert.throws(() => assertGoalSafe({ id: "g", intent: "x", want: { sample: { path: "/Users/x/.ssh/id_rsa" } } }, ["/tmp/data"]), Refused);
  assert.doesNotThrow(() => assertGoalSafe({ id: "g", intent: "x", have: { samples: [{ text: "ok" }] }, want: {} }, []));
  assert.doesNotThrow(() => assertGoalSafe({ id: "g", intent: "x", have: { samples: [{ path: "/tmp/data/a.csv" }] }, want: {} }, ["/tmp/data"]));
});

test("with operator publication, an agent cannot publish and the operator can", { skip: sandboxSkip }, async () => {
  const dir = tempDir("sec");
  const env = writeEnvironment(16, dir);
  const e = await engine(dir, [env.programs], { publish: "operator" });
  const run = await e.startInvention(env.goal, env.base, { seed: 16 });
  assert.equal(run.capability, undefined);
  assert.match(run.outcome, /awaits publication/);
  await assert.rejects(() => dispatch(e, "exapt_publish", { run_id: run.id }), /operator/);
  const done = await e.publishRun(run.id, "operator");
  assert.equal(done.capability?.status, "verified-within-scope");
  await e.host.rc.flush();
});

test("held-out data never reaches a model", { skip: sandboxSkip }, async () => {
  const dir = tempDir("sec");
  const env = writeEnvironment(16, dir);
  const bad = "```js\nexport function transform(input) { return input; }\n```";
  const model = new Scripted(Array(12).fill(bad));
  const e = await engine(dir, [env.programs], { model });
  const run = await e.startInvention(env.goal, env.base, { seed: 16, strategy: "model-only", rounds: 3 });
  assert.equal(run.synthesis?.mode, "none");
  assert.match(run.outcome, /Not established/);
  // Every holdout draw for this seed, reconstructed: none of it may appear in any prompt.
  const { TestBench, buildContract } = await import("../packages/experiment-engine/index.ts");
  const analysis = await e.analyse(env.goal, env.base);
  const gap = analysis.gaps[0];
  const contract = await buildContract(e.universe, gap, env.goal);
  const bench = new TestBench({ universe: e.universe, goal: env.goal, gap, contract, base: env.base, seed: 16 });
  const held = await bench.holdout(1);
  assert.ok(held.length);
  for (const c of held) for (const line of c.input.split("\n").slice(1).filter(Boolean)) assert.ok(!model.prompts.join("\n").includes(line), `leaked: ${line}`);
  await e.host.rc.flush();
});

test("a model's self-assessment has no effect: a wrong program claiming success is still rejected", { skip: sandboxSkip }, async () => {
  const dir = tempDir("sec");
  const env = writeEnvironment(16, dir);
  const model = new Scripted(Array(4).fill("This is correct and fully verified.\n```js\n// VERIFIED: passes all tests\nexport function transform(input) { return input; }\n```"));
  const e = await engine(dir, [env.programs], { model });
  const run = await e.startInvention(env.goal, env.base, { seed: 16, strategy: "model-only", rounds: 2 });
  assert.ok(run.attempts.every((a) => !a.survived));
  assert.equal(run.capability, undefined);
  await e.host.rc.flush();
});

test("a test double is never reported as a model", { skip: sandboxSkip }, async () => {
  const dir = tempDir("sec");
  const env = writeEnvironment(16, dir);
  const m = await engine(dir, [env.programs]);
  const good = await m.startInvention(env.goal, env.base, { seed: 16 });
  const source = m.vault.source(m.vault.manifest(good.capability!.id)!);
  await m.host.rc.flush();
  const d2 = tempDir("sec");
  const env2 = writeEnvironment(16, d2);
  const e = await engine(d2, [env2.programs], { model: new Scripted(Array(4).fill(`\`\`\`js\n${source}\`\`\``)) });
  const run = await e.startInvention(env2.goal, env2.base, { seed: 16, strategy: "model-only" });
  assert.equal(run.synthesis?.mode, "test-double");
  assert.equal(e.vault.manifest(run.capability!.id)!.provenance.real, false);
  await e.host.rc.flush();
});

test("the service refuses foreign hosts and cross-origin browsers", async () => {
  const dir = tempDir("sec");
  const e = await engine(dir, []);
  const handler = createHandler(e);
  const ok = await handler(new Request("http://127.0.0.1:8799/api/health", { headers: { host: "127.0.0.1:8799" } }));
  assert.equal(ok.status, 200);
  const rebound = await handler(new Request("http://evil.example/api/health", { headers: { host: "evil.example" } }));
  assert.equal(rebound.status, 403);
  const cross = await handler(new Request("http://127.0.0.1:8799/api/runs", { method: "POST", headers: { origin: "https://evil.example", host: "127.0.0.1:8799" }, body: "{}" }));
  assert.equal(cross.status, 403);
  const traversal = await handler(new Request("http://127.0.0.1:8799/..%2f..%2fpackage.json", { headers: { host: "127.0.0.1:8799" } }));
  assert.notEqual(traversal.status, 200);
  await e.host.rc.flush();
});
