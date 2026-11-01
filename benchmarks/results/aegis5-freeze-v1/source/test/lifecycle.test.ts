// The acquisition lifecycle, end to end, against real programs and the real execution boundary.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { negativeControls } from "../demos/missing-transformation/controls.ts";
import { rawDump, referenceAdapter, writeEnvironment } from "../demos/missing-transformation/environment.ts";
import { compareRecords, parseRecords, sniff, sniffSyntax } from "../packages/capability-universe/index.ts";
import { Scripted } from "../packages/model-adapters/index.ts";
import { makeCandidate } from "../packages/synthesiser/index.ts";
import { engine, sandboxSkip, tempDir } from "./support.ts";

const matchesReference = async (e: Awaited<ReturnType<typeof engine>>, env: ReturnType<typeof writeEnvironment>, id: string, seed: number) => {
  const p = env.params;
  const exported = await e.universe.tool(p.programs.exporter)!.run(rawDump(p, seed, 30));
  const out = await e.use(id, exported.stdout);
  const expected = referenceAdapter(p, exported.stdout);
  const s = sniffSyntax(expected);
  return compareRecords(parseRecords(expected, s), parseRecords(out.output, s));
};

for (const seed of [16, 2, 28]) {
  test(`deterministic invention across a held-out schema: seed ${seed}`, { skip: sandboxSkip }, async () => {
    const dir = tempDir("life");
    const env = writeEnvironment(seed, dir);
    const e = await engine(dir, [env.programs]);
    const run = await e.startInvention(env.goal, env.base, { seed });
    assert.equal(run.status, "completed", run.outcome);
    assert.equal(run.synthesis?.mode, "deterministic");
    assert.equal(run.evidence?.level, "verified-in-domain", JSON.stringify(run.evidence?.limitations));
    assert.ok(run.workflow?.ok, "the previously impossible workflow runs");
    const c = await matchesReference(e, env, run.capability!.id, seed + 5000);
    assert.ok(c.equal, JSON.stringify(c.diffs));
    assert.ok(e.universe.nodes().some((n) => n.id === run.capability!.id && n.status === "verified-within-scope"));
    assert.ok(e.host.rc.graph.get(run.capability!.id), "it is a real operation of the RightClick X graph");
    assert.equal(e.universe.nodes().filter((n) => n.status === "candidate-missing").length, 0);
    await e.host.rc.flush();
  });
}

test("every negative control is rejected, and none is ever retained", { skip: sandboxSkip }, async () => {
  const dir = tempDir("life");
  const env = writeEnvironment(16, dir);
  const e = await engine(dir, [env.programs]);
  const controls = negativeControls(env.params);
  const run = await e.startInvention(env.goal, env.base, { seed: 16, injected: controls.map((c) => c.candidate) });
  for (const c of controls) {
    const a = run.attempts.find((x) => x.candidate.producer === c.candidate.producer)!;
    assert.equal(a.survived, false, c.name);
  }
  assert.ok(!run.attempts.some((a) => a.candidate.kind === "injected-control" && a.survived));
  assert.notEqual(e.vault.manifest(run.capability!.id)!.provenance.kind, "injected-control");
  assert.ok(e.vault.rejected(20).some((r) => r.kind === "injected-control"), "failures are preserved");
  await e.host.rc.flush();
});

test("a program that passes visible examples by rote is refuted by unseen inputs", { skip: sandboxSkip }, async () => {
  const dir = tempDir("life");
  const env = writeEnvironment(16, dir);
  const e = await engine(dir, [env.programs]);
  // A correct adapter except on values it has not seen a pattern for: it rounds to one place.
  const p = env.params;
  const rote = makeCandidate(negativeControls(p)[3].candidate.source.replace("Math.trunc(", "Math.round(10 * ").replace(`${p.conversion.b})`, `${p.conversion.b}) / 10`), "injected-control", 0, "negative control: one decimal");
  const run = await e.startInvention(env.goal, env.base, { seed: 16, injected: [rote] });
  assert.equal(run.attempts[0].survived, false);
  await e.host.rc.flush();
});

test("capabilities survive restart, and an interrupted run reads unresolved, not failed", { skip: sandboxSkip }, async () => {
  const dir = tempDir("life");
  const env = writeEnvironment(16, dir);
  const first = await engine(dir, [env.programs]);
  const run = await first.startInvention(env.goal, env.base, { seed: 16 });
  const id = run.capability!.id;
  await first.host.rc.flush();
  const stale = first.run(run.id)!;
  fs.mkdirSync(path.join(dir, ".exapt/runs/run_dead"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".exapt/runs/run_dead/run.json"), JSON.stringify({ ...stale, id: "run_dead", status: "running", stage: "synthesising and falsifying", pid: 999999 }));
  const second = await engine(dir, [env.programs]);
  assert.equal(second.run("run_dead")!.status, "unresolved");
  assert.equal(second.run(run.id)!.status, "completed");
  assert.ok(second.host.rc.graph.get(id), "restored as an operation");
  await second.discover();
  const c = await matchesReference(second, env, id, 77);
  assert.ok(c.equal);
  await second.host.rc.flush();
});

test("a compatible change revalidates; an incompatible one invalidates and refuses", { skip: sandboxSkip }, async () => {
  const dir = tempDir("life");
  const env = writeEnvironment(16, dir);
  const e = await engine(dir, [env.programs]);
  const run = await e.startInvention(env.goal, env.base, { seed: 16 });
  const id = run.capability!.id;
  const file = path.join(env.programs, env.params.programs.ingester);
  const original = fs.readFileSync(file, "utf8");
  fs.writeFileSync(file, `${original}\n// a comment\n`);
  assert.equal((await e.revalidate(id)).outcome, "compatible");
  fs.writeFileSync(file, original.replace("e.n++; e.sum += ", "e.n++; e.sum += 3 + "));
  const r = await e.revalidate(id);
  assert.equal(r.outcome, "incompatible");
  assert.ok(r.behaviourChanged.length > 0);
  await assert.rejects(() => e.use(id, "x"), /invalidated/);
  assert.equal(e.host.rc.graph.get(id), undefined, "no route can pass through it");
  await e.host.rc.flush();
});

test("evolution promotes only what passes everything and measurably improves", { skip: sandboxSkip }, async () => {
  const dir = tempDir("life");
  const env = writeEnvironment(16, dir);
  const e = await engine(dir, [env.programs]);
  const clean = await e.startInvention(env.goal, env.base, { seed: 16 });
  const m = e.vault.manifest(clean.capability!.id)!;
  const padded = `// unused\nconst unused = (x) => x;\nconst unusedToo = (x) => x + 1;\n${e.vault.source(m)}`;
  const bloated = { ...m, version: 2, artefact: { ...m.artefact, sha256: e.vault.put(padded), bytes: padded.length } };
  e.vault.retain(bloated);
  e.universe.addGenerated(e.universe.tools.get(m.id)!, { id: m.id, version: 2, status: "verified-within-scope", title: m.title, level: "verified-in-domain", from: m.inputs[0].representation, to: m.outputs[0].representation, oracles: [], dependencies: [], limitations: [] });
  const attempt = await e.evolve(m.id, "smaller");
  assert.ok(attempt.promoted, attempt.outcome);
  assert.equal(e.vault.state(m.id)!.current, attempt.promoted);
  assert.ok(e.vault.manifest(m.id)!.artefact.bytes < padded.length);
  assert.equal(e.vault.manifest(m.id)!.provenance.parent?.version, 2);
  assert.ok(e.evolution(m.id).length === 1);
  const c = await matchesReference(e, env, m.id, 91);
  assert.ok(c.equal);
  await e.host.rc.flush();
});

test("a regressing candidate from a model is recorded and not promoted", { skip: sandboxSkip }, async () => {
  const dir = tempDir("life");
  const env = writeEnvironment(16, dir);
  const scripted = new Scripted(Array(4).fill("```js\nexport function transform(input) { return input; }\n```"));
  const e = await engine(dir, [env.programs], { model: scripted });
  const run = await e.startInvention(env.goal, env.base, { seed: 16, strategy: "deterministic-only" });
  const attempt = await e.evolve(run.capability!.id, "faster");
  assert.equal(attempt.promoted, undefined);
  assert.ok(attempt.candidates.some((c) => c.outcome === "regressed"));
  assert.equal(e.vault.state(run.capability!.id)!.current, 1);
  await e.host.rc.flush();
});

test("a recursive invention stands on an acquired capability", { skip: sandboxSkip }, async () => {
  const dir = tempDir("life");
  const env = writeEnvironment(16, dir, { secondStage: true });
  const e = await engine(dir, [env.programs]);
  const first = await e.startInvention(env.goal, env.base, { seed: 16 });
  assert.equal(first.capability?.status, "verified-within-scope");
  const second = await e.startInvention({ id: "second-stage", intent: "Produce the ledger from a raw device dump", have: env.goal.have, want: { program: `${env.params.theme}-ledger` } }, env.base, { seed: 17 });
  assert.equal(second.capability?.status, "verified-within-scope", second.outcome);
  assert.ok(second.contract!.upstream.includes(first.capability!.id), `built on the first: ${second.contract!.upstream}`);
  assert.match(second.contract!.source.label, /^ndjson/, "the smallest gap starts where the first capability ended");
  const m = e.vault.manifest(second.capability!.id)!;
  assert.ok(m.dependencies.some((d) => d.kind === "capability" && d.id === first.capability!.id));
  assert.ok(second.workflow?.ok);
  assert.ok(second.workflow!.steps.some((s) => s.tool === first.capability!.id));
  // Invalidating the foundation takes what stands on it down too.
  const file = path.join(env.programs, env.params.programs.ingester);
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("e.n++; e.sum += ", "e.n++; e.sum += 3 + "));
  await e.revalidate(first.capability!.id);
  assert.equal(e.vault.manifest(second.capability!.id)!.status, "invalidated");
  await e.host.rc.flush();
});

test("a portable definition must pass here before it does anything here", { skip: sandboxSkip }, async () => {
  const a = tempDir("life");
  const env = writeEnvironment(16, a);
  const source = await engine(a, [env.programs]);
  const run = await source.startInvention(env.goal, env.base, { seed: 16 });
  const bundle = source.exportCapability(run.capability!.id);
  assert.ok(!JSON.stringify(bundle).includes(process.env.HOME ?? "\0"), "no local home path travels");
  await source.host.rc.flush();
  const b = tempDir("life");
  const copy = writeEnvironment(16, b);
  const receiver = await engine(b, [copy.programs]);
  await receiver.discover();
  const imported = await receiver.importCapability(bundle);
  assert.equal(imported.revalidation.outcome, "accepted-import", JSON.stringify(imported.revalidation));
  assert.equal(imported.manifest.status, "verified-within-scope");
  const c = await matchesReference(receiver, copy, run.capability!.id, 3);
  assert.ok(c.equal);
  const elsewhere = tempDir("life");
  const other = writeEnvironment(2, elsewhere);
  const refuser = await engine(elsewhere, [other.programs]);
  await refuser.discover();
  const refused = await refuser.importCapability(bundle);
  assert.equal(refused.revalidation.outcome, "unavailable");
  assert.notEqual(refused.manifest.status, "verified-within-scope");
  await receiver.host.rc.flush();
  await refuser.host.rc.flush();
});

test("new truth refutes a retained capability even though its format still fits", async () => {
  const dir = tempDir("life");
  const e = await engine(dir, []);
  const row = (id: number, v: number) => `id=${id} v=${v}`;
  const truth = (pairs: Array<[number, number]>) => pairs.map(([id, v]) => JSON.stringify({ id: String(id), double: String(v * 2) })).join("\n") + "\n";
  // A retained operation that is right only while v is under 100, which is all it was ever shown.
  const convert = (text: string) => text.trim().split("\n").map((l) => {
    const m = /id=(\d+) v=(\d+)/.exec(l)!;
    return JSON.stringify({ id: m[1], double: String(Number(m[2]) < 100 ? Number(m[2]) * 2 : Number(m[2])) });
  }).join("\n") + "\n";
  const sample = `${row(1, 2)}\n${row(2, 3)}\n`;
  e.universe.tools.set("exapt:retained", {
    id: "exapt:retained", name: "exapt:retained", kind: "generated",
    contract: { tool: "exapt:retained", name: "exapt:retained", docs: "", input: { repr: sniff(sample), requiredFields: [], optionalFields: [], influentialFields: [], positive: [sample], rejected: [] }, output: { repr: sniff(convert(sample)), example: convert(sample) }, options: [], behaviour: "", claims: [], probes: 0 },
    run: async (input) => ({ ok: true, stdout: convert(String(input)), stderr: "", ms: 1, code: 0 }),
  });
  const item = (name: string, pairs: Array<[number, number]>) => ({ name, input: { text: `${pairs.map(([id, v]) => row(id, v)).join("\n")}\n` }, truth: { text: truth(pairs) } });
  const corpus = [item("small", [[1, 2], [2, 3]]), item("also small", [[3, 4], [4, 5]])];
  assert.equal((await e.analyse({ id: "g", intent: "read", corpus, want: { sample: { text: "a sample must not outrank stated truth" } } }, dir)).status, "achievable-existing");
  const a = await e.analyse({ id: "g", intent: "read", corpus: [...corpus, item("large", [[5, 500]])], want: {} }, dir);
  assert.equal(a.status, "gap-found", a.summary);
  assert.deepEqual(a.refuted?.map((r) => r.name), ["large"]);
  assert.match(a.summary, /refuted by new evidence/);
  await e.host.rc.flush();
});

test("a repair becomes the next version of what it repairs, under the same id", { skip: sandboxSkip }, async () => {
  const dir = tempDir("life");
  const env = writeEnvironment(16, dir);
  const e = await engine(dir, [env.programs]);
  const first = await e.startInvention(env.goal, env.base, { seed: 16 });
  const id = first.capability!.id;
  const exported = (await e.universe.tool(env.params.programs.exporter)!.run(rawDump(env.params, 3, 8))).stdout;
  const right = referenceAdapter(env.params, exported);
  const lines = right.trim().split("\n");
  const wrong = [lines[0].replace(/:(-?[0-9.]+),/, ':999,'), ...lines.slice(1)].join("\n") + "\n";
  const corpus = [{ name: "right", input: { text: exported }, truth: { text: right } }, { name: "contradicts the capability", input: { text: exported }, truth: { text: wrong } }];
  const run = await e.startInvention({ id: "repair", intent: "read these", corpus, want: {} }, dir, { seed: 3, rounds: 1, publish: false });
  assert.equal(run.analysis?.refuted?.[0].name, "contradicts the capability");
  assert.equal(run.replaces?.id, id);
  assert.equal(run.goal.corpus?.[1].pinned, true);
  assert.ok(e.vault.state(id)!.history.some((h) => h.event === "refuted"));
  await e.host.rc.flush();
});
