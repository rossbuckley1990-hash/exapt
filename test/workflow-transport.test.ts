// Transport and outcome regressions. The backend never executes candidate code: it records the
// value delivered through the real vault/RCX/workflow path. These are not synthesis evidence.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { inventionExitCode } from "../apps/cli/outcomes.ts";
import { Vault, type CapabilityManifest } from "../packages/capability-memory/index.ts";
import { sniff, type Goal, type Tool } from "../packages/capability-universe/index.ts";
import type { ExecutionBackend } from "../packages/execution/index.ts";
import type { Analysis } from "../packages/gap-reasoner/index.ts";
import { dispatch } from "../packages/protocol/mcp.ts";
import { type WorkflowResult } from "../packages/protocol/engine.ts";
import { engine, tempDir } from "./support.ts";

async function fixture(input: Buffer | string, fail = false) {
  const dir = tempDir("transport");
  const home = path.join(dir, ".exapt");
  const vault = new Vault(home);
  const id = "exapt:transport-fixture";
  const source = "test-only: backend must not execute this";
  vault.retain({
    format: "exapt/capability@1", id, version: 1, status: "verified-within-scope",
    title: "Transport fixture", purpose: "Test bytes crossing the workflow boundary",
    inputs: [{ name: "input", representation: "test", semantic: "bytes" }],
    outputs: [{ name: "output", representation: "text", semantic: "text" }],
    artefact: { sha256: vault.put(source), language: "javascript-esm", entry: "transform", bytes: source.length },
    contract: { inputKind: Buffer.isBuffer(input) ? "binary" : "text", source: { repr: sniff(input), sample: "" }, target: { repr: sniff("hex"), sample: "hex" } } as CapabilityManifest["contract"],
    dependencies: [], environment: { runtime: "test", image: "none", backend: "test-double" },
    permissions: { network: false, filesystem: "none", risk: "read" },
    evidence: { level: "verified-in-domain", oracles: [], assessment: "Test fixture, not verification evidence" } as unknown as CapabilityManifest["evidence"],
    limitations: ["Test fixture only"], counterexamples: [], rejected: [],
    provenance: { goal: "transport", run: "test", producer: "test", kind: "test-double", real: false, createdAt: new Date().toISOString() },
    revalidation: { suite: vault.put('{"cases":[]}'), witnesses: [], instructions: "test only" }, receipts: [],
  });
  const seen: Array<string | Buffer> = [];
  const backend: ExecutionBackend = {
    name: "nonexecuting-test-double", enforces: [], notEstablished: ["does not execute code"],
    async run(req) {
      seen.push(req.input);
      if (fail) return { status: "threw", error: "intentional transport test failure", ms: 0 };
      return { status: "ok", output: Buffer.isBuffer(req.input) ? req.input.toString("hex") : req.input, ms: 0 };
    },
  };
  const e = await engine(dir, [], { backend, dataRoots: [dir] });
  const sample = path.join(dir, "sample");
  fs.writeFileSync(sample, input);
  const goal: Goal = { id: "transport", intent: "Preserve the input", have: { samples: [{ path: sample }] }, want: {} };
  return { e, dir, id, seen, goal, sample };
}

const bytes = Buffer.from([0x54, 0x5a, 0x69, 0x66, 0, 0xff, 0x80, 0xc3, 0x28]);

test("binary goal input survives the workflow, retained reuse and MCP transports byte for byte", async (t) => {
  const f = await fixture(bytes);
  t.after(() => f.e.host.rc.flush());
  t.mock.method(f.e, "analyse", async () => ({ status: "achievable-existing", summary: "fixture route", gaps: [], route: { steps: [{ tool: f.id }] } }) as unknown as Analysis);
  const run = await f.e.startInvention(f.goal, f.dir);
  assert.equal(run.status, "completed", run.outcome);
  assert.equal(run.workflow?.output, bytes.toString("hex"));
  assert.equal(inventionExitCode(run), 0);
  const reused = await f.e.runWorkflow(f.goal.id, bytes);
  assert.equal(reused.output, bytes.toString("hex"));
  for (const args of [{ input: bytes.toString("base64"), encoding: "base64" }, { input_path: f.sample }]) {
    const out = await dispatch(f.e, "exapt_use", { workflow: f.goal.id, ...args }) as WorkflowResult;
    assert.equal(out.ok, true);
    assert.equal(out.output, bytes.toString("hex"));
  }
  assert.equal(f.seen.length, 4);
  for (const actual of f.seen) assert.deepEqual(actual, bytes);
});

test("text goal input remains text at the generated operation", async (t) => {
  const input = "café\n";
  const f = await fixture(input);
  t.after(() => f.e.host.rc.flush());
  t.mock.method(f.e, "analyse", async () => ({ status: "achievable-existing", summary: "fixture route", gaps: [], route: { steps: [{ tool: f.id }] } }) as unknown as Analysis);
  const run = await f.e.startInvention(f.goal, f.dir);
  assert.equal(run.workflow?.output, input);
  assert.deepEqual(f.seen, [input]);
});

test("binary native program input uses the byte-preserving runner", async (t) => {
  const f = await fixture(bytes);
  t.after(() => f.e.host.rc.flush());
  const original = f.e.universe.tool(f.id)!;
  const native: Tool = { ...original, id: "cli:binary-fixture:mined", kind: "program", run: async (input) => {
    assert.deepEqual(input, bytes);
    return { ok: true, stdout: "native bytes intact", stderr: "", ms: 0, code: 0 };
  } };
  f.e.universe.tools.set(native.id, native);
  t.mock.method(f.e, "analyse", async () => ({ status: "achievable-existing", summary: "fixture route", gaps: [], route: { steps: [{ tool: native.id }] } }) as unknown as Analysis);
  const run = await f.e.startInvention(f.goal, f.dir);
  assert.equal(run.workflow?.output, "native bytes intact");
  assert.equal(f.seen.length, 0);
});

test("a failed workflow is persisted as failed and is not saved as a reusable success", async (t) => {
  const f = await fixture(bytes, true);
  t.after(() => f.e.host.rc.flush());
  t.mock.method(f.e, "analyse", async () => ({ status: "achievable-existing", summary: "fixture route", gaps: [], route: { steps: [{ tool: f.id }] } }) as unknown as Analysis);
  const run = await f.e.startInvention(f.goal, f.dir);
  assert.equal(run.status, "failed");
  assert.match(run.outcome, /intentional transport test failure/);
  assert.equal(f.e.run(run.id)?.status, "failed");
  assert.equal(f.e.workflows().length, 0);
  assert.equal(inventionExitCode(run), 1);
  // Reproduce the old contradiction: a verified artifact cannot mask workflow failure.
  assert.equal(inventionExitCode({ ...run, status: "completed", capability: { id: f.id, version: 1, status: "verified-within-scope" } }), 1);
});

test("CLI retains distinct refused, not-established and unresolved outcomes", () => {
  assert.equal(inventionExitCode({ status: "refused" }), 3);
  assert.equal(inventionExitCode({ status: "completed" }), 4);
  assert.equal(inventionExitCode({ status: "unresolved", capability: { id: "exapt:test", version: 1, status: "verified-within-scope" } }), 4);
});
