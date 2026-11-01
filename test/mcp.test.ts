// The agent interface, over the real stdio transport, from a process that shares nothing with the
// one that created the capability.
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { McpSession } from "../demos/inherited-superpower/agents.ts";
import { writeEnvironment } from "../demos/missing-transformation/environment.ts";
import { sandboxSkip, tempDir } from "./support.ts";

test("the whole invention lifecycle works from an MCP client", { skip: sandboxSkip }, async () => {
  const dir = tempDir("mcp");
  const env = writeEnvironment(16, dir);
  const raw = (await import("node:fs")).readFileSync(path.join(dir, "raw.dump"), "utf8");
  const session = new McpSession({ EXAPT_HOME: path.join(dir, ".exapt"), EXAPT_PROGRAMS: env.programs });
  const init = await session.initialize();
  assert.equal(init.tools, 13);
  const goal = { id: "mcp-goal", intent: env.goal.intent, have: { samples: [{ text: raw }] }, want: env.goal.want };
  const discovered = (await session.call("exapt_discover", {})).result as { programs: unknown[] };
  assert.equal(discovered.programs.length, 6);
  const analysis = (await session.call("exapt_analyse", { goal })).result as { status: string };
  assert.equal(analysis.status, "gap-found");
  const gaps = (await session.call("exapt_gaps", { goal })).result as { gaps: Array<{ worthAttempting: boolean }> };
  assert.ok(gaps.gaps[0].worthAttempting);
  const run = (await session.call("exapt_invent", { goal, publish: false })).result as { id: string; outcome: string };
  assert.match(run.outcome, /awaits publication/);
  const experiment = (await session.call("exapt_experiment", { run_id: run.id, seed: 5 })).result as { passed: number; total: number };
  assert.equal(experiment.passed, experiment.total);
  const verified = (await session.call("exapt_verify", { run_id: run.id })).result as { level: string };
  assert.equal(verified.level, "verified-in-domain");
  const published = (await session.call("exapt_publish", { run_id: run.id })).result as { capability: { id: string; status: string } };
  assert.equal(published.capability.status, "verified-within-scope");
  const id = published.capability.id;
  const explained = (await session.call("exapt_explain", { id })).result as { limitations: string[]; domain: string[] };
  assert.ok(explained.limitations.length && explained.domain.length);
  const graph = (await session.call("exapt_rcx", { tool: "context_explain", args: { id } })).result as { id?: string };
  assert.ok(JSON.stringify(graph).includes(id), "RightClick X's own tools see it");
  const missing = await session.call("exapt_use", { id: "exapt:does-not-exist", input: "x" });
  assert.equal(missing.ok, false);
  await session.close();
});

test("a refusal is structured, with a next step", { skip: sandboxSkip }, async () => {
  const dir = tempDir("mcp");
  const session = new McpSession({ EXAPT_HOME: path.join(dir, ".exapt"), EXAPT_PROGRAMS: "" });
  await session.initialize();
  const r = await session.call("exapt_analyse", { goal: { id: "g", intent: "x", have: { samples: [{ path: "/etc/passwd" }] }, want: { program: "p" } } });
  assert.equal(r.ok, false);
  assert.equal((r.result as { refused: string }).refused, "path-not-allowed");
  await session.close();
});
