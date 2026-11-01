// Demonstration 1. An environment of independent programs, an outcome none of them can reach, and
// the transformation that closes the route constructed, tested and made callable. The transformation
// is scored at the end against a reference EXAPT never saw, on inputs it never saw.
import fs from "node:fs";
import path from "node:path";
import { accepted, compareRecords, parseRecords, sniffSyntax } from "../../packages/capability-universe/index.ts";
import { sha256 } from "../../packages/shared/index.ts";
import { bad, good, heading, openEngine, printAttempts, printEvidence, saveReport, say, synthesisLine, workspace } from "../support.ts";
import { negativeControls } from "./controls.ts";
import { rawDump, referenceAdapter, writeEnvironment } from "./environment.ts";

export interface Demo1Result {
  ok: boolean;
  seed: number;
  capability?: string;
  dir: string;
  report: string;
}

export async function demo1(opts: { seed?: number; dir?: string; controls?: boolean } = {}): Promise<Demo1Result> {
  const seed = opts.seed ?? 16;
  const dir = opts.dir ?? workspace("demo1");
  const env = writeEnvironment(seed, dir);
  const home = path.join(dir, ".exapt");
  const exapt = await openEngine(home, [env.programs]);
  const { params: p } = env;
  heading(`Demonstration 1: the missing transformation (seed ${seed})`);
  say(`Environment: ${Object.keys(p.programs).length + 2} independent programs in ${env.programs}`);
  say(`Goal: ${env.goal.intent}`);

  heading("1. Discover what the programs really do");
  const d = await exapt.discover();
  for (const t of exapt.universe.usable()) say(`pre-existing  ${t.name.padEnd(16)} ${t.contract.input?.requiredFields.length ? `requires ${t.contract.input.requiredFields.join(", ")}` : "reads anything"}`);
  say(`${d.learned.length} interfaces established by experiment.`);

  heading("2. Ask whether the outcome is already possible");
  const a = await exapt.analyseCompact(env.goal, env.base);
  say(`RightClick X alone: ${a.rcx.plans} type-level plan(s). ${a.rcx.note}.`);
  say(`EXAPT: ${a.status}. ${a.summary}`);
  const gap = a.gaps[0];
  if (gap) say(`Oracles found in the environment: ${gap.oracles.join(", ")}`);

  heading("3. Confirm no program in this environment bridges the gap");
  const exported = await exapt.universe.tool(p.programs.exporter)!.run(fs.readFileSync(path.join(dir, "raw.dump"), "utf8"));
  const consumer = exapt.universe.tool(p.programs.ingester)!;
  const direct = await consumer.run(exported.stdout);
  if (accepted(direct)) bad("the consumer accepted the exporter's output directly");
  else good(`${p.programs.ingester} refuses what ${p.programs.exporter} writes: ${direct.stderr.trim().slice(0, 80)}`);
  const bridges = [];
  for (const t of exapt.universe.usable()) {
    const r = await t.run(exported.stdout);
    if (accepted(r) && accepted(await consumer.run(r.stdout))) bridges.push(t.name);
  }
  if (bridges.length) bad(`an existing adapter exists: ${bridges.join(", ")}`);
  else good("no existing program turns that output into anything the consumer accepts");

  heading("4. Construct the capability");
  const controls = opts.controls === false ? [] : negativeControls(p);
  if (controls.length) say(`${controls.length} deliberately wrong programs are submitted first, as negative controls.`);
  const run = await exapt.startInvention(env.goal, env.base, { seed, injected: controls.map((c) => c.candidate) });
  printAttempts(run);
  const escaped = run.attempts.filter((x) => x.candidate.kind === "injected-control" && x.survived);
  say(synthesisLine(run));

  heading("5. Independent assessment");
  printEvidence(run);

  heading("6. The route that was impossible now runs");
  if (run.workflow?.ok) {
    say(run.workflow.steps.map((s) => (s.kind === "generated" ? `[NEW ${s.tool}]` : s.tool)).join(" -> "));
    say(run.workflow.output.split("\n").slice(0, 3).join("\n  "));
  } else bad("the workflow did not complete");

  heading("7. Scoring on withheld inputs against a reference EXAPT never saw");
  let matched = 0;
  const trials = 8;
  let scored = 0;
  if (run.capability?.status === "verified-within-scope") {
    for (let i = 0; i < trials; i++) {
      const raw = rawDump(p, 900_000 + seed + i, 40 + i);
      const b = await exapt.universe.tool(p.programs.exporter)!.run(raw);
      const r = await exapt.use(run.capability.id, b.stdout);
      const expected = referenceAdapter(p, b.stdout);
      const syntax = sniffSyntax(expected);
      const c = compareRecords(parseRecords(expected, syntax), parseRecords(r.output, syntax));
      scored++;
      if (c.equal) matched++;
      else say(`mismatch: ${JSON.stringify(c.diffs[0])}`);
    }
    if (matched === scored) good(`${matched}/${scored} withheld inputs matched the reference exactly`);
    else bad(`${matched}/${scored} withheld inputs matched the reference`);
  }

  heading("8. Is this a generated program or a fixture?");
  let artefact = "";
  let original = false;
  if (run.capability) {
    const m = exapt.vault.manifest(run.capability.id)!;
    artefact = m.artefact.sha256;
    const files = fs.readdirSync(env.programs).map((f) => sha256(fs.readFileSync(path.join(env.programs, f))));
    original = !files.includes(artefact);
    if (original) good(`artefact ${artefact.slice(0, 16)} is not any program in the environment, and the schema it serves was drawn from seed ${seed}`);
    say(`provenance: ${m.provenance.producer}, run ${m.provenance.run}`);
  }
  const ok = !escaped.length && !bridges.length && !accepted(direct) && !!run.workflow?.ok && matched === scored && scored > 0 && original;
  const report = saveReport(dir, "demo1-report", {
    seed, params: { delimiter: p.delimiter, conversion: p.conversion.name, id: p.idTransform }, analysis: { status: a.status, rcx: a.rcx, gap: gap?.title, oracles: gap?.oracles },
    controls: controls.map((c) => ({ name: c.name, fault: c.fault, rejected: run.attempts.some((x) => x.candidate.producer === c.candidate.producer && !x.survived), at: run.attempts.find((x) => x.candidate.producer === c.candidate.producer)?.rejectedAt })),
    attempts: run.attempts.map((x) => ({ producer: x.candidate.producer, level: x.level, rejectedAt: x.rejectedAt, reason: x.reason })), evidence: run.evidence, synthesis: run.synthesis, capability: run.capability, workflow: run.workflow, withheld: { matched, scored }, artefact,
  });
  console.log(`\n${ok ? "\x1b[32mDemonstration 1 passed.\x1b[0m" : "\x1b[31mDemonstration 1 did not pass.\x1b[0m"} Report: ${report}`);
  await exapt.host.rc.flush();
  return { ok, seed, capability: run.capability?.id, dir, report };
}
