// Runs one trial of arm C (RightClick X alone) or arm D (EXAPT) in its own process and prints a JSON
// result. Arm C uses the inherited runtime exactly as shipped: no mined contracts, no synthesis.
import fs from "node:fs";
import path from "node:path";
import { compareOutputs, HOME_FOR, loadCases, type Trial } from "./scoring.ts";
import { RcxHost } from "../packages/rcx-adapter/index.ts";
import { configFromEnv, Exapt } from "../packages/protocol/engine.ts";
import type { Goal } from "../packages/capability-universe/index.ts";
import type { TaskSpec } from "./families.ts";

const [arm, taskDir, workspace, resultFile] = process.argv.slice(2);
const task = JSON.parse(fs.readFileSync(path.join(workspace, "task.json"), "utf8")) as TaskSpec;
const programs = [path.join(workspace, "programs"), ...(task.hostPrograms ?? [])].filter((p) => fs.existsSync(p));
const cases = loadCases(task.id, "cases");
const t0 = performance.now();

async function armC(): Promise<Trial> {
  const home = HOME_FOR(workspace);
  const host = await RcxHost.open({ home, programs });
  const rc = host.rc;
  const dirPrograms = path.join(workspace, "programs");
  if (fs.existsSync(dirPrograms)) for (const f of fs.readdirSync(dirPrograms)) await rc.learn({ source: `cli:${path.join(dirPrograms, f)}` });
  const goal = task.goal as unknown as Goal;
  const target = goal.want.program;
  const anchor = target ? rc.graph.list().find((c) => c.provider === `cli:${target}`)?.id : undefined;
  const sample = goal.have?.samples?.[0]?.path;
  const notes: string[] = [];
  let claimed: Trial["claimed"] = "not-possible";
  let slug: string | undefined;
  if (!sample || !target) notes.push("no text input and target program to compose from");
  else if (!anchor) notes.push(`RightClick X holds no capability for ${target}`);
  else {
    slug = "bench-goal";
    const r = await rc.compose({ have: { input: { type: "text", value: fs.readFileSync(path.join(workspace, sample), "utf8") } }, want: "text", intent: goal.intent, through: [anchor], run: true, publish: slug }).catch((e) => {
      notes.push(String(e.message).slice(0, 200));
      return null;
    });
    notes.push(`plans ${r?.plans.length ?? 0}, executed ${r?.executed?.status ?? "no"}`);
    if (r?.executed?.status === "completed" && r.published) claimed = "done";
  }
  const passed: boolean[] = [];
  if (claimed === "done") {
    for (const c of cases) {
      const out = await rc.run(`goal:${slug}`, { input: c.input }).catch(() => null);
      passed.push(!!out && out.status === "completed" && compareOutputs(c.expected, String(out.output ?? ""), task.compare));
    }
  }
  await rc.flush();
  return { arm: "C", stage: "cold", task: task.id, claimed, hidden: { passed: passed.filter(Boolean).length, total: claimed === "done" ? cases.length : 0 }, costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, ms: Math.round(performance.now() - t0), codeBytes: 0, notes };
}

async function armD(): Promise<Trial> {
  const home = HOME_FOR(workspace);
  const e = await Exapt.open(configFromEnv(process.env, { home, programs, strategy: "auto", budget: { maxCalls: 10, maxTokens: 150_000, maxCostUsd: 1 } }));
  const goal = task.goal as unknown as Goal;
  const run = await e.startInvention(goal, workspace, { seed: 2026 });
  const verified = run.capability?.status === "verified-within-scope";
  const route = !run.capability && !!run.workflow?.ok;
  const claimed: Trial["claimed"] = verified || route ? "done" : "not-possible";
  const passed: boolean[] = [];
  if (claimed === "done") {
    const firstCap = run.capability?.id;
    for (const c of cases) {
      try {
        // Workflows carry text; a binary input goes straight to the capability that reads it.
        const steps = !c.binary && e.workflows().length ? await e.runWorkflow(goal.id, c.input).catch(() => null) : null;
        const output = steps?.ok ? steps.output : firstCap ? (await e.use(firstCap, c.input, c.binary ? { encoding: "base64" } : {})).output : "";
        passed.push(compareOutputs(c.expected, output, task.compare));
      } catch {
        passed.push(false);
      }
    }
  }
  const m = run.capability ? e.vault.manifest(run.capability.id) : undefined;
  // An unverified candidate is not a claim and scores as a refusal. Whether it happened to be right
  // is measured separately, so the price of refusing to claim it can be seen.
  let unverified: { passed: number; total: number } | undefined;
  if (m && !verified && m.evidence.level !== "not-established") {
    const source = e.vault.source(m);
    let passed = 0;
    for (const c of cases) {
      let value: string | Buffer = c.binary ? Buffer.from(c.input, "base64") : c.input;
      let ok = true;
      for (const id of m.contract.upstream) {
        const r = await e.universe.tool(id)!.run(value);
        ok &&= r.ok;
        value = r.stdout;
      }
      const out = ok ? await e.backend.run({ source, input: value }) : null;
      let result = out?.output ?? "";
      for (const id of m.contract.downstream) {
        const r = await e.universe.tool(id)!.run(result);
        result = r.stdout;
      }
      if (compareOutputs(c.expected, result, task.compare)) passed++;
    }
    unverified = { passed, total: cases.length };
  }
  await e.host.rc.flush();
  return {
    arm: "D", stage: "cold", task: task.id, claimed, hidden: { passed: passed.filter(Boolean).length, total: claimed === "done" ? cases.length : 0 },
    costUsd: run.budget?.costUsd ?? 0, inputTokens: run.budget?.inputTokens ?? 0, outputTokens: run.budget?.outputTokens ?? 0, turns: run.budget?.calls ?? 0, ms: Math.round(performance.now() - t0), codeBytes: verified ? m?.artefact.bytes ?? 0 : 0,
    notes: [run.outcome.slice(0, 300), `analysis ${run.analysis?.status}`, `synthesis ${run.synthesis?.mode ?? "none"} ${run.synthesis?.producer ?? ""}`, `level ${run.evidence?.level ?? "none"}`, `attempts ${run.attempts.length}`, ...run.notes.slice(0, 3)],
    detail: { unverified, capability: run.capability, gap: run.gap, attempts: run.attempts.map((a) => ({ producer: a.candidate.producer, level: a.level, rejectedAt: a.rejectedAt, reason: a.reason?.slice(0, 200) })), mutation: run.evidence?.mutation, tiers: run.evidence?.tiers, limitations: run.evidence?.limitations },
  };
}

const trial = arm === "C" ? await armC() : await armD();
fs.writeFileSync(resultFile, JSON.stringify(trial, null, 2));
void taskDir;
