import assert from "node:assert/strict";
import test from "node:test";
import { writeEnvironment } from "../demos/missing-transformation/environment.ts";
import { createHandler } from "../apps/server/index.ts";
import { engine, sandboxSkip, tempDir } from "./support.ts";

test("the service runs a job, reports it, and shows only real state", { skip: sandboxSkip }, async () => {
  const dir = tempDir("http");
  const env = writeEnvironment(16, dir);
  const e = await engine(dir, [env.programs]);
  await e.discover();
  const handler = createHandler(e, { goals: [{ id: env.goal.id, title: env.goal.intent, goal: env.goal, base: env.base }] });
  const call = async (path: string, body?: unknown) => {
    const r = await handler(new Request(`http://127.0.0.1:8799${path}`, body === undefined ? { headers: { host: "127.0.0.1:8799" } } : { method: "POST", headers: { host: "127.0.0.1:8799", "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json() : await r.text() };
  };
  const before = (await call("/api/state")).body;
  assert.equal(before.counts.verified, 0, "nothing is shown as acquired until something is");
  assert.equal(before.model, null);
  const job = await call("/api/runs", { goalId: env.goal.id, seed: 16 });
  assert.equal(job.status, 202);
  let run;
  for (let i = 0; i < 300; i++) {
    run = (await call(`/api/runs/${job.body.id}`)).body;
    if (run.status !== "running" && run.status !== "queued") break;
    await new Promise((r) => setTimeout(r, 500));
  }
  assert.equal(run.status, "completed", run.outcome);
  const events = (await call(`/api/runs/${job.body.id}/events`)).body;
  assert.ok(events.some((x: { type: string }) => x.type === "candidate.proposed"));
  const vault = (await call("/api/capabilities")).body;
  assert.equal(vault.total, 1);
  const detail = (await call(`/api/capabilities/${encodeURIComponent(vault.capabilities[0].id)}`)).body;
  assert.match(detail.source, /export function transform/);
  const universe = (await call("/api/universe")).body;
  assert.ok(universe.flow.some((f: { status: string }) => f.status === "verified-within-scope"));
  assert.equal((await call("/rcx/health")).body.ok, true);
  assert.match((await call("/")).body, /EXAPT Lab/);
  assert.equal((await call("/api/capabilities/exapt:nope/use", { input: "x" })).status, 404);
  await e.host.rc.flush();
});
