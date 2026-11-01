// Engine D: experimental falsification. Candidate programs are hypotheses. This loop tries to refute
// each one, turns refutations into constraints for the next attempt, and stops at explicit budgets.
// A program that survives has only failed to be refuted within a stated domain, and the result says
// exactly that. Generated code, successful execution and plausible output are never treated as
// evidence of correctness on their own.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type EvidenceLevel, type Goal, type Rec, type Universe, compareRecords, isRecordRepr, parseRecords, renderRecords, sniffSyntax } from "../capability-universe/index.ts";
import type { ExecutionBackend, Limits, RunResult } from "../execution/index.ts";
import type { Gap } from "../gap-reasoner/index.ts";
import type { Budget, ModelAdapter } from "../model-adapters/index.ts";
import { pool, Rng, sha256 } from "../shared/index.ts";
import { propose, type Candidate, type Counterexample, type Pair, type Strategy } from "../synthesiser/index.ts";
import { TestBench, buildContract, specFor, type BehaviouralContract, type BenchSizes, type TestCase, type Tier } from "./bench.ts";
import { describeDiff, Judge, type CaseResult, type Failure } from "./judge.ts";
import { permuteRecords } from "./generators.ts";

export * from "./bench.ts";
export * from "./judge.ts";
export * from "./generators.ts";

export type EventSink = (type: string, data: Record<string, unknown>) => void;

export interface CandidateAssessment {
  candidate: Omit<Candidate, "source">;
  level: EvidenceLevel;
  survived: boolean;
  /** The first gate this candidate failed. */
  rejectedAt?: string;
  reason?: string;
  tiers: Partial<Record<Tier | "metamorphic", { passed: number; total: number }>>;
  failures: Array<{ tier: string; oracle: string; detail: string }>;
  source?: string;
}

export interface InventionResult {
  status: "accepted" | "exhausted";
  reason: string;
  contract: BehaviouralContract;
  bench: TestBench;
  accepted?: Candidate;
  best?: CandidateAssessment;
  attempts: CandidateAssessment[];
  counterexamples: Counterexample[];
  holdoutDraws: number;
  notes: string[];
}

export interface InventionOptions {
  universe: Universe;
  goal: Goal;
  gap: Gap;
  base: string;
  backend: ExecutionBackend;
  model: ModelAdapter | null;
  budget: Budget;
  strategy: Strategy;
  seed: number;
  rounds?: number;
  candidatesPerRound?: number;
  sizes?: Partial<BenchSizes>;
  helpers?: Array<{ name: string; purpose: string }>;
  libs?: Record<string, string>;
  /** Controls: candidates tested before synthesis, exactly as if a synthesiser had proposed them. */
  injected?: Candidate[];
  /** A retained version this run replaces: the model starts from it rather than from nothing. */
  starting?: string;
  onEvent?: EventSink;
  onModelCall?: (entry: Record<string, unknown>) => void;
}

export function syntaxValid(source: string): { ok: boolean; error?: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "exapt-syntax-"));
  const file = path.join(dir, "candidate.mjs");
  try {
    fs.writeFileSync(file, source);
    // --check parses and does not execute.
    const r = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", timeout: 10_000 });
    return r.status === 0 ? { ok: true } : { ok: false, error: (r.stderr ?? "").split("\n").slice(0, 5).join(" ").slice(0, 300) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const inputOf = (t: TestCase): string | Buffer => (t.binary ? Buffer.from(t.input, "base64") : t.input);

/** Run and judge a batch. Concurrency is bounded so limits stay meaningful. */
export async function runCases(backend: ExecutionBackend, judge: Judge, source: string, cases: TestCase[], libs?: Record<string, string>, limits?: Partial<Limits>): Promise<CaseResult[]> {
  return pool(cases, 6, async (c) => {
    let run = await backend.run({ source, input: inputOf(c), libs, limits });
    // A hang hangs twice. One timeout on a busy machine says nothing about the program.
    if (run.status === "timeout" || run.status === "crash") run = await backend.run({ source, input: inputOf(c), libs, limits });
    return judge.judge(c, run);
  });
}

const tally = (rs: CaseResult[]) => ({ passed: rs.filter((r) => r.passed).length, total: rs.length });

/** Properties relating several runs: same input twice, and input in a different order. */
export async function metamorphicChecks(backend: ExecutionBackend, source: string, contract: BehaviouralContract, cases: TestCase[], seed: number, libs?: Record<string, string>): Promise<{ results: Array<{ relation: string; passed: boolean; detail: string }> }> {
  const out: Array<{ relation: string; passed: boolean; detail: string }> = [];
  const rng = new Rng(seed);
  const sample = cases.filter((c) => c.input.length > 0).slice(0, 3);
  const once = (input: string | Buffer) => backend.run({ source, input, libs });
  for (const c of sample) {
    const [a, b] = await Promise.all([once(inputOf(c)), once(inputOf(c))]);
    out.push({ relation: "determinism", passed: a.status === "ok" && a.output === b.output && a.outputBase64 === b.outputBase64, detail: a.status === b.status ? "repeated run compared" : `${a.status} then ${b.status}` });
  }
  const { source: from, target: to } = contract;
  if (isRecordRepr(from.repr) && isRecordRepr(to.repr)) {
    for (const c of sample.filter((x) => !x.binary).slice(0, 2)) {
      const p = permuteRecords(c.input, from.repr, rng);
      if (!p) continue;
      const [a, b] = await Promise.all([once(c.input), once(p.input)]);
      if (a.status !== "ok" || b.status !== "ok" || a.output === undefined || b.output === undefined) {
        out.push({ relation: "permutation", passed: false, detail: `${a.status}/${b.status}` });
        continue;
      }
      const [base, moved] = [parseRecords(a.output, to.repr.syntax), parseRecords(b.output, to.repr.syntax)];
      const inputCount = parseRecords(c.input, from.repr.syntax).length;
      if (base.length === inputCount) {
        const cmp = compareRecords(p.order.map((i) => base[i]), moved);
        out.push({ relation: "permutation", passed: cmp.equal, detail: cmp.equal ? "output followed the input's order" : describeDiff(cmp.diffs[0]) });
        out.push({ relation: "record-count", passed: true, detail: `${base.length} records out` });
      } else {
        const sortKey = (r: Rec) => JSON.stringify(r);
        const sortedBase = [...base].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
        const sortedMoved = [...moved].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
        const cmp = compareRecords(sortedBase, sortedMoved);
        out.push({ relation: "permutation", passed: cmp.equal, detail: cmp.equal ? "output records invariant under input permutation" : describeDiff(cmp.diffs[0]) });
        out.push({ relation: "record-count", passed: base.length === moved.length, detail: `${base.length} records out` });
      }
    }
  }
  return { results: out };
}

const VALUE_ORACLES = new Set(["ground-truth", "stated-examples", "inverse-pair", "inverse-route", "operator-checker", "terminal-differential"]);
export const hasValueOracle = (r: CaseResult): boolean => r.exercised.some((o) => VALUE_ORACLES.has(o));

/** Delta-debug a failing record input down to a small counterexample. */
async function shrink(backend: ExecutionBackend, judge: Judge, source: string, test: TestCase, contract: BehaviouralContract, libs?: Record<string, string>): Promise<TestCase> {
  if (test.binary || test.tier === "malformed" || !isRecordRepr(contract.source.repr) || test.expected !== undefined) return test;
  const names = contract.source.repr.fields.map((f) => f.name);
  let rows: Rec[];
  try {
    rows = parseRecords(test.input, contract.source.repr.syntax);
  } catch {
    return test;
  }
  let chunk = Math.ceil(rows.length / 2);
  let evaluations = 0;
  let best = test;
  while (chunk >= 1 && rows.length > 1 && evaluations < 12) {
    let reduced = false;
    for (let i = 0; i < rows.length && evaluations < 12; i += chunk) {
      const fewer = [...rows.slice(0, i), ...rows.slice(i + chunk)];
      if (!fewer.length) continue;
      const trial: TestCase = { ...test, input: renderRecords(fewer, contract.source.repr.syntax, names) };
      evaluations++;
      const r = await judge.judge(trial, await backend.run({ source, input: trial.input, libs }));
      if (!r.passed) {
        rows = fewer;
        best = trial;
        reduced = true;
        break;
      }
    }
    if (!reduced) chunk = Math.floor(chunk / 2);
  }
  return best;
}

function reasonOf(f: Failure | undefined): string {
  return f ? `${f.oracle}: ${f.detail}` : "failed";
}

function firstRecord(p: Pair): Pair {
  if (p.binary) return p;
  try {
    const [from, to] = [sniffSyntax(p.input), sniffSyntax(p.output)];
    if (["text", "binary"].includes(from.format) || ["text", "binary"].includes(to.format)) return p;
    const [a, b] = [parseRecords(p.input, from), parseRecords(p.output, to)];
    if (a.length < 2 || a.length !== b.length) return p;
    return { input: renderRecords(a.slice(0, 1), from, Object.keys(a[0])), output: renderRecords(b.slice(0, 1), to, Object.keys(b[0])) };
  } catch {
    return p;
  }
}

/** The counterexample-guided loop. */
export async function invent(o: InventionOptions): Promise<InventionResult> {
  const emit: EventSink = o.onEvent ?? (() => {});
  const contract = await buildContract(o.universe, o.gap, o.goal);
  const bench = new TestBench({ universe: o.universe, goal: o.goal, gap: o.gap, contract, base: o.base, seed: o.seed, sizes: o.sizes });
  const judge = new Judge(o.universe, contract);
  const spec = specFor(o.universe, contract, o.goal.intent);
  emit("contract.built", { contract: contract.id, source: contract.source.label, target: contract.target.label, oracles: contract.oracles.map((x) => x.kind), tolerance: contract.tolerance });

  const visible = await bench.visible();
  const known: Pair[] = visible.filter((c) => c.expected !== undefined).map((c) => ({ input: c.input, output: c.expected!, ...(c.binary ? { binary: true } : {}) }));
  const boundary = await bench.boundary();
  const malformed = bench.malformed();
  emit("tests.prepared", { visible: visible.length, boundary: boundary.length, malformed: malformed.length, knownPairs: known.length });

  // Start from the least evidence that could suggest a program, a single record, so the search's
  // first hypothesis is the simplest one and refutation has to pull in everything else.
  let training: Pair[] = known.slice(0, 1).map(firstRecord);
  const rounds = o.rounds ?? o.goal.budget?.rounds ?? 6;
  const perRound = o.candidatesPerRound ?? o.goal.budget?.candidatesPerRound ?? 2;
  const attempts: CandidateAssessment[] = [];
  const counterexamples: Counterexample[] = [];
  const rejected: Array<{ source: string; reason: string }> = [];
  const tried = new Set<string>();
  const notes: string[] = [];
  let holdoutDraws = 0;
  let injected = [...(o.injected ?? [])];
  let lastOutcome = "no candidate was proposed";

  const assess = async (cand: Candidate, round: number): Promise<CandidateAssessment> => {
    const a: CandidateAssessment = { candidate: { ...cand, source: undefined } as unknown as Omit<Candidate, "source">, level: "not-established", survived: false, tiers: {}, failures: [], source: cand.source };
    const refuse = (gate: string, results: CaseResult[], tier: string): CandidateAssessment => {
      const bad = results.filter((r) => !r.passed);
      a.rejectedAt = gate;
      a.reason = reasonOf(bad[0]?.failures[0]);
      a.failures = bad.slice(0, 6).flatMap((r) => r.failures.slice(0, 2).map((f) => ({ tier, oracle: f.oracle, detail: f.detail })));
      return a;
    };
    const syntax = syntaxValid(cand.source);
    if (!syntax.ok) {
      a.rejectedAt = "syntax";
      a.reason = syntax.error;
      return a;
    }
    a.level = "syntax-valid";
    const seen = await runCases(o.backend, judge, cand.source, visible, o.libs);
    a.tiers.visible = tally(seen);
    if (seen.some((r) => r.failures.every((f) => f.oracle !== "execution") || r.passed)) a.level = "executed";
    if (seen.some((r) => !r.passed)) return await learn(refuse("visible", seen, "visible"), seen, visible, cand);
    if (visible.length) a.level = "passed-visible";
    const independentCases = await bench.independent(round);
    const independent = await runCases(o.backend, judge, cand.source, independentCases, o.libs);
    a.tiers.independent = tally(independent);
    if (independent.some((r) => !r.passed)) return await learn(refuse("independent", independent, "independent"), independent, independentCases, cand);
    const meta = await metamorphicChecks(o.backend, cand.source, contract, independentCases, o.seed + round, o.libs);
    a.tiers.metamorphic = { passed: meta.results.filter((m) => m.passed).length, total: meta.results.length };
    const brokenMeta = meta.results.find((m) => !m.passed);
    if (brokenMeta) {
      a.rejectedAt = "metamorphic";
      a.reason = `${brokenMeta.relation}: ${brokenMeta.detail}`;
      a.failures = [{ tier: "metamorphic", oracle: brokenMeta.relation, detail: brokenMeta.detail }];
      counterexamples.push({ input: independentCases[0]?.input ?? "", problem: a.reason, binary: independentCases[0]?.binary });
      return a;
    }
    const edge = await runCases(o.backend, judge, cand.source, boundary, o.libs);
    a.tiers.boundary = tally(edge);
    if (edge.some((r) => !r.passed)) return await learn(refuse("boundary", edge, "boundary"), edge, boundary, cand);
    const bad = await runCases(o.backend, judge, cand.source, malformed, o.libs);
    a.tiers.malformed = tally(bad);
    if (bad.some((r) => !r.passed)) return await learn(refuse("malformed", bad, "malformed"), bad, malformed, cand);
    if (independent.length) a.level = "passed-independent";
    holdoutDraws++;
    const heldOut = await bench.holdout(holdoutDraws);
    const hidden = await runCases(o.backend, judge, cand.source, heldOut, o.libs);
    a.tiers.holdout = tally(hidden);
    if (!heldOut.length) {
      a.rejectedAt = "holdout";
      a.reason = "no held-out cases could be constructed for this gap";
      return a;
    }
    if (hidden.some((r) => !r.passed)) {
      // Deliberately no feedback: what failed on held-out data is not told to any synthesiser.
      a.rejectedAt = "holdout";
      a.reason = `${hidden.filter((r) => !r.passed).length} of ${hidden.length} held-out cases failed`;
      a.failures = [{ tier: "holdout", oracle: "held-out", detail: a.reason }];
      return a;
    }
    a.level = "passed-holdout";
    a.survived = true;
    return a;
  };

  const learn = async (a: CandidateAssessment, results: CaseResult[], cases: TestCase[], cand: Candidate): Promise<CandidateAssessment> => {
    const failing = results.map((r, i) => ({ r, c: cases[i] })).filter((x) => !x.r.passed).slice(0, 3);
    for (const { r, c } of failing) {
      if (c.expected !== undefined && !training.some((p) => p.input === c.input)) training.push({ input: c.input, output: c.expected, ...(c.binary ? { binary: true } : {}) });
      const small = await shrink(o.backend, judge, cand.source, c, contract, o.libs);
      const f = r.failures[0];
      const diff = f?.diffs?.[0];
      counterexamples.push({ input: small.input, problem: reasonOf(f), ...(c.binary ? { binary: true } : {}), ...(diff ? { expected: JSON.stringify(diff.expected), actual: JSON.stringify(diff.actual) } : {}) });
      emit("counterexample", { candidate: cand.id, tier: c.tier, problem: reasonOf(f).slice(0, 240), inputChars: small.input.length, shrunkFrom: c.input.length });
    }
    return a;
  };

  for (let round = 1; round <= rounds; round++) {
    const stop = o.budget.exhausted;
    if (stop && o.strategy === "model-only") {
      notes.push(stop);
      emit("budget.exhausted", { reason: stop });
      break;
    }
    emit("round.started", { round, trainingPairs: training.length, counterexamples: counterexamples.length });
    let batch: Candidate[];
    if (injected.length) {
      batch = injected.filter((c) => !tried.has(c.sha256));
      injected = [];
    } else {
      const proposal = await propose({
        spec, pairs: training, allPairs: [...new Map([...known, ...training].map((p) => [p.input, p])).values()], counterexamples, rejected, helpers: o.helpers ?? [], starting: o.starting,
        round, wanted: perRound, tried, strategy: o.strategy, model: o.model, budget: o.budget, onModelCall: o.onModelCall,
      });
      for (const n of proposal.notes) {
        notes.push(n);
        emit("synthesis.note", { round, note: n });
      }
      batch = proposal.candidates;
    }
    if (!batch.length) {
      if (training.length < known.length) {
        training = known;
        continue;
      }
      lastOutcome = notes[notes.length - 1] ?? lastOutcome;
      if (round > 1 || !o.model) break;
      continue;
    }
    for (const cand of batch) {
      tried.add(cand.sha256);
      emit("candidate.proposed", { candidate: cand.id, producer: cand.producer, kind: cand.kind, round, sha256: cand.sha256, bytes: cand.source.length, explanation: cand.explanation });
      const a = await assess(cand, round);
      attempts.push(a);
      if (a.survived) {
        emit("candidate.survived", { candidate: cand.id, level: a.level, tiers: a.tiers });
        return { status: "accepted", reason: "survived every gate within budget", contract, bench, accepted: cand, best: a, attempts, counterexamples, holdoutDraws, notes };
      }
      rejected.push({ source: cand.source, reason: a.reason ?? "rejected" });
      lastOutcome = `${a.rejectedAt}: ${a.reason}`;
      emit("candidate.rejected", { candidate: cand.id, producer: cand.producer, level: a.level, rejectedAt: a.rejectedAt, reason: a.reason?.slice(0, 300), tiers: a.tiers, failures: a.failures.slice(0, 3) });
    }
    // After the first refutation, the search may use every visible example.
    for (const p of known) if (!training.some((x) => x.input === p.input)) {
      training.push(p);
      break;
    }
  }
  // A negative control is never a capability, however far it got.
  const best = attempts.filter((a) => a.candidate.kind !== "injected-control").sort((x, y) => levelIndex(y.level) - levelIndex(x.level))[0];
  return { status: "exhausted", reason: attempts.length ? `no candidate survived; last: ${lastOutcome}` : lastOutcome, contract, bench, best, attempts, counterexamples, holdoutDraws, notes };
}

const LEVEL_ORDER: EvidenceLevel[] = ["not-established", "syntax-valid", "executed", "passed-visible", "passed-independent", "passed-holdout", "verified-in-domain"];
const levelIndex = (l: EvidenceLevel): number => LEVEL_ORDER.indexOf(l);

// ---------------------------------------------------------------- mutation adequacy

/** Small faults injected into an accepted program. A suite that cannot tell them apart from the
 *  original was not testing what it appeared to test. */
export function mutantsOf(source: string, limit = 24): Mutant[] {
  const out: Mutant[] = [];
  const code = codePositions(source);
  const inErrorMessage = (i: number): boolean => {
    const start = source.lastIndexOf("\n", i) + 1;
    return source.slice(start, i).includes("throw new Error(");
  };
  const at = (pattern: RegExp, make: (m: RegExpMatchArray) => string, name: string, kind: Mutant["kind"] = "value") => {
    for (const m of source.matchAll(pattern)) {
      const i = m.index!;
      // Only code can be a fault. Text in a comment, string, template or regex is not, and an altered
      // error message changes no behaviour. Counting these would mark good, commented code down.
      if (!code[i] || inErrorMessage(i)) continue;
      out.push({ name: `${name} at ${i}`, kind, source: source.slice(0, i) + make(m) + source.slice(i + m[0].length) });
    }
  };
  const body = source.indexOf("transform(");
  at(/(?<=[\s(])(\d+)(?=\s*[)/*;,+-])/g, (m) => String(Number(m[1]) + 1), "literal changed");
  at(/ \* /g, () => " / ", "multiplication became division");
  at(/ \/ /g, () => " * ", "division became multiplication");
  at(/ \+ (?=\d|-)/g, () => " - ", "offset sign flipped");
  at(/\.toFixed\((\d+)\)/g, (m) => `.toFixed(${Math.max(0, Number(m[1]) - 1)})`, "precision reduced");
  // The standard logic operators. Programs that keep their work in conditions, rather than in
  // arithmetic, would otherwise offer almost nothing to mutate, and a score over a handful of faults
  // is mostly noise.
  at(/ === /g, () => " !== ", "equality inverted");
  at(/ !== /g, () => " === ", "inequality inverted");
  at(/ && /g, () => " || ", "conjunction became disjunction");
  at(/ \|\| /g, () => " && ", "disjunction became conjunction");
  at(/ < /g, () => " <= ", "boundary moved");
  at(/ > /g, () => " >= ", "boundary moved");
  at(/\bcontinue;/g, () => ";", "continue removed");
  at(/\bbreak;/g, () => ";", "break removed");
  at(/\.pop\(\)/g, () => ".length", "pop removed");
  at(/\bif \(!/g, () => "if (", "condition negated");
  at(/\btrue\b/g, () => "false", "boolean flipped");
  at(/\bfalse\b/g, () => "true", "boolean flipped");
  at(/\.toUpperCase\(\)/g, () => "", "case change removed");
  at(/\.trim\(\)/g, () => "", "trim removed", "robustness");
  at(/throw new Error\(/g, () => "void String(", "validation removed", "robustness");
  const names = [...source.slice(Math.max(0, body)).matchAll(/field\(r, ("[^"]+")\)/g)].map((m) => m[1]);
  for (let i = 1; i < names.length; i++) {
    if (names[i] !== names[0]) out.push({ name: `fields swapped: ${names[0]} and ${names[i]}`, kind: "value", source: source.replace(`field(r, ${names[0]})`, "field(r, \0)").replace(`field(r, ${names[i]})`, `field(r, ${names[0]})`).replace("field(r, \0)", `field(r, ${names[i]})`) });
  }
  // The sample comes from the program itself, so assessing it again gives the same faults. A verdict
  // cannot be improved by asking twice.
  const rng = new Rng(parseInt(sha256(source).slice(0, 8), 16));
  const unique = [...new Map(out.filter((m) => m.source !== source).map((m) => [sha256(m.source), m])).values()];
  const valueFaults = rng.shuffle(unique.filter((m) => m.kind === "value")).slice(0, Math.ceil(limit * 0.75));
  const robustness = rng.shuffle(unique.filter((m) => m.kind === "robustness"));
  return [...valueFaults, ...robustness].slice(0, limit);
}

/** True at each index that is code: not a comment, string, template text or regex literal. */
export function codePositions(source: string): boolean[] {
  const out = new Array<boolean>(source.length).fill(true);
  let i = 0;
  let last = ""; // the last significant character, to tell a regex from a division
  const mark = (from: number, to: number) => out.fill(false, from, Math.min(to, source.length));
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? source.length : end;
      mark(i, stop);
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? source.length : end + 2;
      mark(i, stop);
      i = stop;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < source.length && source[j] !== c) j += source[j] === "\\" ? 2 : 1;
      mark(i, j + 1);
      i = j + 1;
      last = c;
    } else if (c === "/" && (!last || /[(,=:[!&|?{};+\-*%<>~^\n]/.test(last) || /\breturn\s*$/.test(source.slice(Math.max(0, i - 8), i)))) {
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== "\n" && (source[j] !== "/" || inClass)) {
        if (source[j] === "\\") j++;
        else if (source[j] === "[") inClass = true;
        else if (source[j] === "]") inClass = false;
        j++;
      }
      mark(i, j + 1);
      i = j + 1;
      last = "/";
    } else {
      if (!/\s/.test(c)) last = c;
      i++;
    }
  }
  return out;
}

export interface Mutant {
  name: string;
  source: string;
  /** A value fault changes what comes out. A robustness fault weakens defensive code, and is often
   *  equivalent to the original, so the two are counted apart. */
  kind: "value" | "robustness";
}

export interface MutationScore {
  killed: number;
  total: number;
  value: { killed: number; total: number };
  survivors: string[];
  /** Reproducible identities and killing cases; absent only in older evidence records. */
  details?: Array<{ name: string; kind: Mutant["kind"]; sha256: string; killed: boolean; tested: string[]; killedBy: string[] }>;
}

export async function mutationScore(backend: ExecutionBackend, judge: Judge, source: string, cases: TestCase[], libs?: Record<string, string>): Promise<MutationScore> {
  const mutants = mutantsOf(source);
  // Every kind of test must be present: a fault in validation shows only on malformed input.
  const batches: Array<[string, number]> = [["visible", 2], ["independent", 6], ["holdout", 4], ["boundary", 12], ["malformed", 8]];
  const outcomes = await pool(mutants, 2, async (m) => {
    const tested: string[] = [];
    // Most faults die on the first batch, so stop there. A fault can loop forever; it gets less rope.
    for (const [tier, n] of batches) {
      const suite = cases.filter((c) => c.tier === tier).slice(0, n);
      if (!suite.length) continue;
      const rs = await runCases(backend, judge, m.source, suite, libs, { timeoutMs: 3000 });
      tested.push(...suite.map(c => c.id));
      if (rs.some((r) => !r.passed)) return { name: m.name, kind: m.kind, sha256: sha256(m.source), killed: true, tested, killedBy: rs.filter(r => !r.passed).map(r => r.id) };
    }
    return { name: m.name, kind: m.kind, sha256: sha256(m.source), killed: false, tested, killedBy: [] };
  });
  const value = outcomes.filter((o) => o.kind === "value");
  return { killed: outcomes.filter((o) => o.killed).length, total: outcomes.length, value: { killed: value.filter((o) => o.killed).length, total: value.length }, survivors: outcomes.filter((o) => !o.killed).map((o) => o.name), details: outcomes };
}

export type { RunResult };
