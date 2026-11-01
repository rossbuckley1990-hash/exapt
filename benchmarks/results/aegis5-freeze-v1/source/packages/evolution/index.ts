// Engine F: bounded, audited improvement of a retained capability. An attempt states an objective,
// produces candidates, and must pass everything the current version passed plus a measured
// improvement. Nothing is silently replaced: a candidate that wins becomes a new version, one that
// regresses is recorded and dropped. EXAPT's own runtime and policy are never candidates, because
// the only thing evolution can write is a new version of a generated artefact.
import path from "node:path";
import fs from "node:fs";
import { Judge, runCases, syntaxValid, type TestCase } from "../experiment-engine/index.ts";
import type { ExecutionBackend } from "../execution/index.ts";
import type { Budget, ModelAdapter } from "../model-adapters/index.ts";
import { newId, Refused, sha256, writeJson, readJson } from "../shared/index.ts";
import { makeCandidate, propose, type Candidate, type Pair, type SynthesisSpec } from "../synthesiser/index.ts";
import type { Universe } from "../capability-universe/index.ts";
import type { CapabilityManifest, Vault } from "../capability-memory/index.ts";

export type Objective = "smaller" | "faster" | "leaner" | "robust" | "simpler";

export interface Measurement {
  bytes: number;
  lines: number;
  medianMs: number;
  peakRssKb: number;
}

export interface EvolutionAttempt {
  id: string;
  capability: string;
  fromVersion: number;
  objective: Objective;
  startedAt: string;
  finishedAt?: string;
  baseline: Measurement;
  candidates: Array<{ sha256: string; producer: string; outcome: "promoted" | "regressed" | "no-improvement" | "invalid"; reason: string; measured?: Measurement }>;
  promoted?: number;
  outcome: string;
  budget?: Record<string, unknown>;
}

export const LIMITS = { maxGenerations: 8, maxCandidates: 6 };

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

async function measure(backend: ExecutionBackend, source: string, cases: TestCase[], libs: Record<string, string>): Promise<Measurement> {
  // A workload large enough to be timed, run sequentially so one run cannot disturb another.
  const workload = cases.filter((c) => c.tier !== "malformed").sort((a, b) => b.input.length - a.input.length).slice(0, 3);
  const ms: number[] = [];
  let rss = 0;
  for (const c of [...workload, ...workload, ...workload]) {
    const r = await backend.run({ source, input: c.binary ? Buffer.from(c.input, "base64") : c.input, libs });
    if (r.status === "ok") {
      ms.push(r.ms);
      rss = Math.max(rss, r.rssKb ?? 0);
    }
  }
  return { bytes: Buffer.byteLength(source), lines: source.split("\n").filter((l) => l.trim()).length, medianMs: Number(median(ms).toFixed(2)), peakRssKb: rss };
}

const improved = (o: Objective, base: Measurement, next: Measurement): boolean => {
  switch (o) {
    case "smaller":
    case "simpler":
      return next.bytes < base.bytes * 0.98;
    case "faster":
      return next.medianMs < base.medianMs * 0.9;
    case "leaner":
      return next.peakRssKb < base.peakRssKb * 0.95;
    case "robust":
      return true; // judged by the widened suite alone
  }
};

/** Top-level statements: a line at column zero and whatever hangs beneath it. */
function statements(lines: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let start = 0;
  for (let i = 1; i <= lines.length; i++) {
    const closes = i < lines.length && /^[)}\]]/.test(lines[i]);
    if (i === lines.length || (/^\S/.test(lines[i]) && !closes)) {
      out.push([start, i]);
      start = i;
    }
  }
  return out;
}

/** Remove what the evidence does not need: delete whole statements, then single lines, keeping only
 *  deletions under which the conformance suite still passes. Needs no model. */
async function deletionSearch(backend: ExecutionBackend, judge: Judge, source: string, suite: TestCase[], libs: Record<string, string>): Promise<{ source: string; evaluations: number }> {
  let lines = source.split("\n");
  let evaluations = 0;
  const LIMIT = 80;
  const passes = async (candidate: string[]): Promise<boolean> => {
    const text = candidate.join("\n");
    if (!syntaxValid(text).ok) return false;
    evaluations++;
    const quick = await runCases(backend, judge, text, suite.slice(0, 2), libs);
    if (quick.some((r) => !r.passed)) return false;
    return (await runCases(backend, judge, text, suite.slice(2), libs)).every((r) => r.passed);
  };
  for (const [from, to] of statements(lines).reverse()) {
    if (evaluations >= LIMIT) break;
    const trial = [...lines.slice(0, from), ...lines.slice(to)];
    if (await passes(trial)) lines = trial;
  }
  for (let i = lines.length - 1; i >= 0 && evaluations < LIMIT; i--) {
    if (!lines[i].trim()) continue;
    const trial = [...lines.slice(0, i), ...lines.slice(i + 1)];
    if (await passes(trial)) lines = trial;
  }
  return { source: lines.join("\n"), evaluations };
}

export interface EvolveContext {
  universe: Universe;
  vault: Vault;
  backend: ExecutionBackend;
  model: ModelAdapter | null;
  budget: Budget;
  home: string;
  libs: Record<string, string>;
  contractFor: (m: CapabilityManifest) => CapabilityManifest["contract"];
  specFor: (m: CapabilityManifest) => SynthesisSpec;
  /** Retain a promoted version; provided by the engine, which owns activation. */
  promote: (m: CapabilityManifest, source: string, attempt: EvolutionAttempt, measured: Measurement) => Promise<CapabilityManifest>;
}

const conformance = (cases: TestCase[]): TestCase[] => {
  const quota: Record<string, number> = { visible: 3, independent: 10, boundary: 8, malformed: 8 };
  return Object.entries(quota).flatMap(([tier, n]) => cases.filter((c) => c.tier === tier).slice(0, n));
};

export async function evolve(ctx: EvolveContext, m: CapabilityManifest, objective: Objective, opts: { maxCandidates?: number } = {}): Promise<EvolutionAttempt> {
  const generation = ctx.vault.state(m.id)?.versions.length ?? 1;
  if (generation >= LIMITS.maxGenerations) throw new Refused("evolution-limit", `${m.id} has reached the limit of ${LIMITS.maxGenerations} versions`);
  if (m.status !== "verified-within-scope") throw new Refused("not-verified", `${m.id}@${m.version} is ${m.status}; only a verified version can be evolved`);
  const contract = ctx.contractFor(m);
  const judge = new Judge(ctx.universe, contract);
  const source = ctx.vault.source(m);
  const suite = ctx.vault.suite(m).cases;
  const quick = conformance(suite);
  const baseline = await measure(ctx.backend, source, suite, ctx.libs);
  const attempt: EvolutionAttempt = { id: newId("evo"), capability: m.id, fromVersion: m.version, objective, startedAt: new Date().toISOString(), baseline, candidates: [], outcome: "" };
  const candidates: Candidate[] = [];
  if (objective === "smaller" || objective === "simpler") {
    const d = await deletionSearch(ctx.backend, judge, source, quick, ctx.libs);
    if (d.source !== source) candidates.push(makeCandidate(d.source, "deletion-search", 1, "deletion search", [`${d.evaluations} evaluations`]));
  }
  if (ctx.model) {
    const words: Record<Objective, string> = {
      smaller: "Produce a much smaller implementation.", simpler: "Replace this with a simpler implementation.", faster: "Make this measurably faster on large inputs, for example by avoiding repeated work.",
      leaner: "Reduce peak memory on large inputs.", robust: "Make this more robust to unusual but valid input without changing any existing behaviour.",
    };
    const pairs: Pair[] = suite.filter((c) => c.expected !== undefined).slice(0, 3).map((c) => ({ input: c.input, output: c.expected!, ...(c.binary ? { binary: true } : {}) }));
    const p = await propose({ spec: ctx.specFor(m), pairs, counterexamples: [], rejected: [], helpers: [], objective: `${words[objective]} Every existing behaviour must be preserved exactly.`, starting: source, round: 1, wanted: 2, tried: new Set([sha256(source)]), strategy: "model-only", model: ctx.model, budget: ctx.budget });
    candidates.push(...p.candidates);
  }
  attempt.budget = ctx.budget.snapshot();
  if (!candidates.length) {
    const deletion = objective === "smaller" || objective === "simpler";
    attempt.outcome = deletion ? "deletion search found nothing the evidence does not need" : ctx.model ? "no candidate was proposed" : "no deterministic route to this objective, and no model is configured";
  }
  for (const cand of candidates.slice(0, opts.maxCandidates ?? LIMITS.maxCandidates)) {
    const record = (outcome: EvolutionAttempt["candidates"][number]["outcome"], reason: string, measured?: Measurement) => attempt.candidates.push({ sha256: cand.sha256, producer: cand.producer, outcome, reason, ...(measured ? { measured } : {}) });
    if (!syntaxValid(cand.source).ok) {
      record("invalid", "does not parse");
      continue;
    }
    const rs = await runCases(ctx.backend, judge, cand.source, suite, ctx.libs);
    const failed = rs.filter((r) => !r.passed);
    if (failed.length) {
      record("regressed", `${failed.length} of ${rs.length} original checks failed; first: ${failed[0].failures[0]?.oracle}: ${failed[0].failures[0]?.detail?.slice(0, 200)}`);
      continue;
    }
    const measured = await measure(ctx.backend, cand.source, suite, ctx.libs);
    if (!improved(objective, baseline, measured)) {
      record("no-improvement", `no measured improvement against the objective (${objective})`, measured);
      continue;
    }
    const promoted = await ctx.promote(m, cand.source, attempt, measured);
    attempt.promoted = promoted.version;
    record("promoted", `passed all ${rs.length} original checks and independent re-verification; version ${promoted.version}`, measured);
    attempt.outcome = `promoted ${m.id}@${promoted.version}`;
    break;
  }
  if (!attempt.promoted && !attempt.outcome) attempt.outcome = "no candidate improved on the current version without regression";
  attempt.finishedAt = new Date().toISOString();
  writeJson(path.join(ctx.home, "evolution", `${attempt.id}.json`), attempt);
  return attempt;
}

export function evolutionHistory(home: string, id?: string): EvolutionAttempt[] {
  const dir = path.join(home, "evolution");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).sort().map((f) => readJson<EvolutionAttempt>(path.join(dir, f))!).filter((a) => !id || a.capability === id);
}

