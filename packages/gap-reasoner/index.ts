// Engine B: the missing-capability reasoner.
//
// Forward: from what the caller has, run every program that accepts it and keep what it really
// produced. Reachability here is witnessed, not inferred from labels. Backward: from what the
// caller wants, walk to every representation that would be enough, again from observed behaviour.
// A route exists when the two meet. When they do not, every pair of (a value that can be reached,
// a representation that would be enough) is a candidate missing edge, and the reasoner decides
// which is the smallest, which can be built, and above all which could be checked, because a
// capability nothing could verify is not worth inventing.
//
// The graph supplies more than the gap. A program that writes the source format generates test
// inputs; a consumer tests acceptance; a program running the other way yields ground truth. Tools
// built for something else become the verification instruments for what is being built: exaptation.
import { digest, Refused } from "../shared/index.ts";
import { accepted, fieldCoverage, isRecordRepr, nameAffinity, reprFits, reprLabel, sameSyntax, sniff, type Field, type Goal, type Repr, type SampleRef, type Tool, type Universe } from "../capability-universe/index.ts";
import fs from "node:fs";
import path from "node:path";

export interface Witness {
  id: string;
  bytes: Buffer;
  repr: Repr;
  label: string;
  /** The tools that produced this value from the caller's input, in order. */
  lineage: Array<{ tool: string; args?: string[] }>;
}

export interface Requirement {
  id: string;
  repr: Repr;
  label: string;
  requiredFields: string[];
  /** A confirmed positive sample of this requirement. */
  sample?: string;
  /** The program that needs it, or null for a caller-stated target. */
  consumer: string | null;
  /** Tools that must still run after this requirement is met. */
  downstream: string[];
}

export type OracleSpec =
  | { kind: "consumer-acceptance"; tool: string; independent: true; valueLevel: false }
  | { kind: "inverse-route"; route: string[]; independent: true; valueLevel: true }
  | { kind: "ground-truth"; items: number; independent: true; valueLevel: true }
  | { kind: "stated-examples"; items: number; independent: true; valueLevel: true }
  | { kind: "operator-checker"; program: string; independent: true; valueLevel: true }
  | { kind: "terminal-differential"; route: string[]; independent: true; valueLevel: true }
  | { kind: "metamorphic"; relation: "record-count" | "permutation" | "concatenation" | "determinism"; independent: false; valueLevel: false };

export interface GapScores {
  feasibility: number;
  complexity: number;
  oracle: number;
  reusability: number;
  downstream: number;
  runtimeCost: number;
  securityRisk: number;
  semanticConfidence: number;
}

export interface Gap {
  id: string;
  title: string;
  from: Witness;
  to: Requirement;
  score: number;
  scores: GapScores;
  oracles: OracleSpec[];
  /** Target fields nothing in the source appears to determine. */
  missingInformation: string[];
  needsModel: boolean;
  constructible: boolean;
  verifiable: boolean;
  worthAttempting: boolean;
  minimumImplementation: string;
  evidenceNeeded: string[];
  reasons: string[];
}

export type AnalysisStatus = "achievable-existing" | "achievable-composition" | "gap-found" | "underspecified" | "not-constructible" | "unverifiable";

export interface Analysis {
  goal: string;
  status: AnalysisStatus;
  summary: string;
  rcx: { plans: number; best?: string; note: string };
  route?: { steps: Array<{ tool: string; args?: string[] }>; output: string; label: string };
  reachable: Array<{ label: string; lineage: string[] }>;
  required: Array<{ label: string; consumer: string | null; downstream: string[]; requiredFields: string[] }>;
  gaps: Gap[];
  limitations: string[];
  questions: string[];
}

export function loadSample(s: SampleRef, base: string): Buffer {
  if (s.text !== undefined) return Buffer.from(s.text);
  if (s.base64 !== undefined) return Buffer.from(s.base64, "base64");
  if (s.path) return fs.readFileSync(path.resolve(base, s.path));
  throw new Refused("goal-invalid", "a sample needs one of path, text or base64");
}

const summarizeGap = (g: Gap) => `${g.from.label} -> ${g.to.label}`;

/** Run forward from the caller's values. Every value here was actually produced. */
async function forward(tools: Tool[], seeds: Buffer[], depth: number): Promise<Witness[]> {
  const out: Witness[] = [];
  const seen = new Set<string>();
  const push = (w: Witness) => {
    if (seen.has(w.label)) return false;
    seen.add(w.label);
    out.push(w);
    return true;
  };
  for (const [i, bytes] of seeds.entries()) {
    const repr = sniff(bytes);
    push({ id: `have-${i}`, bytes, repr, label: reprLabel(repr), lineage: [] });
  }
  let frontier = [...out];
  for (let d = 0; d < depth && frontier.length; d++) {
    const next: Witness[] = [];
    for (const v of frontier) {
      for (const t of tools) {
        if (v.lineage.some((l) => l.tool === t.id)) continue;
        if (v.repr.syntax.format === "binary") continue; // programs here read text
        const r = await t.run(v.bytes.toString("utf8")).catch(() => null);
        if (!r || !accepted(r)) continue;
        const bytes = Buffer.from(r.stdout);
        const repr = sniff(bytes);
        const w: Witness = { id: `v${out.length}`, bytes, repr, label: reprLabel(repr), lineage: [...v.lineage, { tool: t.id }] };
        if (push(w)) next.push(w);
      }
    }
    frontier = next;
  }
  return out;
}

function targetsFor(goal: Goal, tools: Tool[], base: string): Requirement[] {
  const out: Requirement[] = [];
  if (goal.want.sample) {
    const bytes = loadSample(goal.want.sample, base);
    const repr = sniff(bytes);
    out.push({ id: "target", repr, label: reprLabel(repr), requiredFields: repr.fields.map((f) => f.name), sample: bytes.toString("utf8"), consumer: null, downstream: [] });
  } else if (goal.want.examples?.length) {
    const bytes = loadSample(goal.want.examples[0].output, base);
    const repr = sniff(bytes);
    out.push({ id: "target", repr, label: reprLabel(repr), requiredFields: repr.fields.map((f) => f.name), sample: bytes.toString("utf8"), consumer: null, downstream: [] });
  } else if (goal.corpus?.length) {
    const bytes = loadSample(goal.corpus[0].truth, base);
    const repr = sniff(bytes);
    out.push({ id: "target", repr, label: reprLabel(repr), requiredFields: [], sample: bytes.toString("utf8"), consumer: null, downstream: [] });
  }
  const program = goal.want.program ? tools.find((t) => t.name === goal.want.program || t.id === goal.want.program) : undefined;
  if (program?.contract.input) {
    const c = program.contract.input;
    out.push({ id: `in:${program.id}`, repr: c.repr, label: reprLabel(c.repr), requiredFields: c.requiredFields, sample: c.positive[0], consumer: program.id, downstream: [program.id] });
  }
  // Walk backward: anything producing a requirement makes its own input sufficient too.
  for (let i = 0; i < out.length && out.length < 16; i++) {
    const r = out[i];
    for (const t of tools) {
      if (!t.contract.input || !t.contract.output || t.id === r.consumer || r.downstream.includes(t.id)) continue;
      if (!reprFits(t.contract.output.repr, r.repr, r.requiredFields.length ? r.requiredFields : undefined)) continue;
      const c = t.contract.input;
      const label = reprLabel(c.repr);
      if (out.some((x) => x.label === label)) continue;
      out.push({ id: `in:${t.id}`, repr: c.repr, label, requiredFields: c.requiredFields, sample: c.positive[0], consumer: t.id, downstream: [t.id, ...r.downstream] });
    }
  }
  return out;
}

/** Tools or short routes that turn a value of the target representation back into the source one. */
async function inverseRoutes(tools: Tool[], from: Witness, to: Requirement): Promise<string[][]> {
  if (!to.sample || !isRecordRepr(from.repr)) return [];
  const names = new Set(from.repr.fields.map((f) => f.name));
  const out: string[][] = [];
  for (const t of tools) {
    if (t.id === to.consumer || from.lineage.some((l) => l.tool === t.id)) continue;
    const r = await t.run(to.sample).catch(() => null);
    if (!r || !accepted(r)) continue;
    const repr = sniff(r.stdout);
    if (!sameSyntax(repr.syntax, from.repr.syntax)) continue;
    if (repr.fields.length === names.size && repr.fields.every((f) => names.has(f.name))) out.push([t.id]);
  }
  return out;
}

function complexityOf(from: Repr, to: Repr): number {
  if (from.syntax.format === "binary") return 0.2;
  const syntax = sameSyntax(from.syntax, to.syntax) ? 1 : 0.7;
  return syntax * Math.max(0.2, 1 - to.fields.length / 40);
}

function semanticConfidence(from: Repr, to: Repr): number {
  if (!to.fields.length) return 0.3;
  const best = to.fields.map((t) => Math.max(0, ...from.fields.map((s) => nameAffinity(s.name, t.name))));
  return best.reduce((a, b) => a + b, 0) / best.length;
}

type ValueClass = "temporal" | "numeric" | "text";

const classOf = (f: Field): ValueClass => {
  if (f.kind === "date" || f.kind === "datetime") return "temporal";
  if (f.kind === "int" && (f.min ?? 0) > 1e8) return "temporal"; // epoch-shaped
  if (f.kind === "int" || f.kind === "decimal") return "numeric";
  return "text";
};

/** Fields of the target nothing in the source can determine. A field is determined by a source of
 *  a compatible class that is not plainly the origin of a different target field. This is a
 *  conservative test of information, not of meaning: it can only rule a route out. */
function missingFields(from: Repr, to: Requirement): string[] {
  if (!isRecordRepr(from)) return [];
  const needed = to.requiredFields.length ? to.requiredFields : to.repr.fields.map((f) => f.name);
  return needed.filter((name) => {
    const t = to.repr.fields.find((f) => f.name === name);
    if (!t || t.cardinality === 1 && to.repr.records > 1) return false; // a constant needs no source
    if (from.fields.some((s) => nameAffinity(s.name, name) > 0 || t.samples.some((v) => v !== "" && s.samples.includes(v)))) return false;
    const wanted = classOf(t);
    return !from.fields.some((s) => {
      if (classOf(s) !== wanted && !(wanted === "text" && classOf(s) !== "temporal")) return false;
      return !to.repr.fields.some((o) => o.name !== name && nameAffinity(s.name, o.name) > 0 && classOf(o) === classOf(s));
    });
  });
}

export const WEIGHTS: Record<keyof GapScores, number> = { feasibility: 3, oracle: 4, complexity: 1.5, reusability: 1, downstream: 1, runtimeCost: 0.5, securityRisk: 0.5, semanticConfidence: 2 };

function score(s: GapScores): number {
  const total = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
  return (Object.entries(s) as Array<[keyof GapScores, number]>).reduce((sum, [k, v]) => sum + WEIGHTS[k] * v, 0) / total;
}

export interface AnalyseOptions {
  base: string;
  /** Whether a model is configured; some gaps cannot be attempted without one. */
  modelAvailable: boolean;
  /** Tools the caller excludes from this analysis. */
  exclude?: string[];
  depth?: number;
}

/** Decide whether an outcome is reachable, and if not, exactly what is missing. */
export async function analyse(universe: Universe, goal: Goal, opts: AnalyseOptions): Promise<Analysis> {
  const tools = universe.usable().filter((t) => !opts.exclude?.includes(t.id));
  const questions: string[] = [];
  if (!goal.have?.samples?.length && !goal.corpus?.length && !goal.want.examples?.length) questions.push("What input does this start from? Give have.samples, or a corpus with truth.");
  if (!goal.want.program && !goal.want.sample && !goal.want.examples?.length && !goal.corpus?.length) questions.push("What does success look like? Name want.program, or give want.sample, want.examples or a corpus.");
  if (goal.want.program && !tools.some((t) => t.name === goal.want.program || t.id === goal.want.program)) {
    const known = universe.tool(goal.want.program);
    questions.push(known ? `${goal.want.program} is known but no accepted input for it has been observed; give a sample it accepts.` : `${goal.want.program} is not an authorised program here.`);
  }
  const empty: Analysis = { goal: goal.id, status: "underspecified", summary: questions[0] ?? "", rcx: { plans: 0, note: "not consulted" }, reachable: [], required: [], gaps: [], limitations: [], questions };
  if (questions.length) return empty;

  const seeds = [
    ...(goal.have?.samples ?? []).map((s) => loadSample(s, opts.base)),
    ...(goal.want.examples ?? []).slice(0, 1).map((e) => loadSample(e.input, opts.base)),
    ...(goal.corpus ?? []).slice(0, 1).map((c) => loadSample(c.input, opts.base)),
  ];
  const reached = await forward(tools, seeds, opts.depth ?? 3);
  const required = targetsFor(goal, tools, opts.base);

  // What plain RightClick X composition would do: its route, not its verdict.
  const rcx = await consultRcx(universe, goal, seeds[0]);
  const base = { goal: goal.id, rcx, reachable: reached.map((w) => ({ label: w.label, lineage: w.lineage.map((l) => l.tool) })), required: required.map((r) => ({ label: r.label, consumer: r.consumer, downstream: r.downstream, requiredFields: r.requiredFields })), limitations: [] as string[], questions };

  const finished = (w: Witness): boolean => {
    if (goal.want.program) {
      const t = tools.find((x) => x.name === goal.want.program || x.id === goal.want.program);
      return !!t && w.lineage.some((l) => l.tool === t.id);
    }
    const target = required.find((r) => r.id === "target");
    return !!target && target.requiredFields.length > 0 && reprFits(w.repr, target.repr, target.requiredFields);
  };
  const done = reached.find(finished);
  if (done) {
    const composite = done.lineage.length > 1;
    return { ...base, status: composite ? "achievable-composition" : "achievable-existing", summary: `Reachable with what exists: ${done.lineage.map((l) => l.tool).join(" -> ") || "the input already fits"}. Nothing needs to be invented.`, route: { steps: done.lineage, output: done.bytes.toString("utf8").slice(0, 2000), label: done.label }, gaps: [] };
  }

  // A documented option on a required consumer may already bridge the gap.
  for (const r of required) {
    const t = r.consumer ? tools.find((x) => x.id === r.consumer) : undefined;
    if (!t?.contract.options.length) continue;
    for (const v of reached) {
      if (v.repr.syntax.format === "binary") continue;
      for (const o of t.contract.options) for (const value of o.values) {
        const flag = o.flags.find((f) => f.startsWith("--")) ?? o.flags[0];
        for (const args of [[`${flag}=${value}`], [flag, value]]) {
          const run = await t.run(v.bytes.toString("utf8"), { args }).catch(() => null);
          if (run && accepted(run) && run.stdout !== t.contract.output?.example) {
            const steps = [...v.lineage, { tool: t.id, args }];
            return { ...base, status: "achievable-existing", summary: `Reachable without new code: ${t.name} accepts this input with its documented option ${args.join(" ")}.`, route: { steps, output: run.stdout.slice(0, 2000), label: reprLabel(sniff(run.stdout)) }, gaps: [] };
          }
        }
      }
    }
  }

  const consumers = (repr: Repr) => tools.filter((t) => t.contract.input && sameSyntax(t.contract.input.repr.syntax, repr.syntax)).length;
  const producers = (repr: Repr) => tools.filter((t) => t.contract.output && sameSyntax(t.contract.output.repr.syntax, repr.syntax)).length;
  const gaps: Gap[] = [];
  for (const from of reached) {
    for (const to of required) {
      if (from.repr.syntax.format === "text" && to.repr.syntax.format !== "text" && from.lineage.length) continue; // a report is not a source
      const oracles: OracleSpec[] = [];
      if (to.consumer) oracles.push({ kind: "consumer-acceptance", tool: to.consumer, independent: true, valueLevel: false });
      if (goal.corpus?.length) oracles.push({ kind: "ground-truth", items: goal.corpus.length, independent: true, valueLevel: true });
      if (goal.want.examples?.length) oracles.push({ kind: "stated-examples", items: goal.want.examples.length, independent: true, valueLevel: true });
      if (goal.checker) oracles.push({ kind: "operator-checker", program: goal.checker, independent: true, valueLevel: true });
      for (const route of await inverseRoutes(tools, from, to)) oracles.push({ kind: "inverse-route", route, independent: true, valueLevel: true });
      if (isRecordRepr(from.repr) && isRecordRepr(to.repr)) oracles.push({ kind: "metamorphic", relation: "record-count", independent: false, valueLevel: false }, { kind: "metamorphic", relation: "permutation", independent: false, valueLevel: false });
      oracles.push({ kind: "metamorphic", relation: "determinism", independent: false, valueLevel: false });
      const valueLevel = oracles.filter((o) => o.valueLevel);
      const coverage = fieldCoverage(from.repr, to.repr);
      const binary = from.repr.syntax.format === "binary";
      const textual = from.repr.syntax.format === "text";
      const missing = missingFields(from.repr, to);
      const needsModel = !valueLevel.some((o) => o.kind !== "operator-checker") || textual;
      const scores: GapScores = {
        feasibility: binary ? 0.45 : textual ? 0.3 : Math.max(0.1, coverage * (missing.length ? 0.4 : 1)),
        complexity: complexityOf(from.repr, to.repr),
        oracle: valueLevel.length ? Math.min(1, 0.7 + 0.15 * valueLevel.length) : to.consumer ? 0.3 : 0,
        reusability: Math.min(1, (consumers(to.repr) + producers(from.repr)) / 4),
        downstream: Math.min(1, to.downstream.length / 3),
        runtimeCost: 0.9,
        securityRisk: 0.95,
        semanticConfidence: semanticConfidence(from.repr, to.repr),
      };
      const verifiable = valueLevel.length > 0;
      const constructible = missing.length === 0;
      const reasons: string[] = [];
      if (!constructible) reasons.push(`nothing in ${from.label} appears to determine: ${missing.join(", ")}`);
      if (!verifiable) reasons.push("no value-level independent oracle: a result could be retained only as experimental");
      if (needsModel && !opts.modelAvailable) reasons.push("no model is configured, and the deterministic synthesiser needs value pairs or a recoverable record structure for this gap");
      const gap: Gap = {
        id: `gap-${digest([from.label, to.label]).slice(0, 10)}`,
        title: "", from, to, scores, score: score(scores), oracles,
        missingInformation: missing, needsModel, constructible, verifiable,
        worthAttempting: constructible && verifiable && (!needsModel || opts.modelAvailable || binary),
        minimumImplementation: `a pure transformation from ${from.label} to ${to.label}`,
        evidenceNeeded: [
          ...valueLevel.map((o) => `${o.kind} agreement on inputs the implementation has never seen`),
          ...(to.consumer ? [`${to.consumer} accepts every output`] : []),
          "deterministic behaviour; correct refusal of malformed input",
        ],
        reasons,
      };
      gap.title = summarizeGap(gap);
      gaps.push(gap);
    }
  }
  gaps.sort((a, b) => Number(b.constructible) - Number(a.constructible) || b.score - a.score);
  const seen = new Set<string>();
  const ranked = gaps.filter((g) => !seen.has(g.title) && seen.add(g.title)).slice(0, 8);
  universe.noteMissing(ranked.filter((g) => g.constructible).slice(0, 3).map((g) => ({ id: `missing:${g.id}`, title: g.minimumImplementation, from: g.from.label, to: g.to.label, status: "candidate-missing", rank: g.score, goal: goal.id })));
  const best = ranked[0];
  if (!best) return { ...base, status: "not-constructible", summary: "No representation that would satisfy this goal could be established from the environment.", gaps: [], limitations: ["no target representation is known"] };
  if (!ranked.some((g) => g.constructible)) return { ...base, status: "not-constructible", summary: `Not constructible from what is available: ${best.reasons[0]}.`, gaps: ranked, limitations: best.reasons };
  if (!ranked.some((g) => g.constructible && g.verifiable)) return { ...base, status: "unverifiable", summary: `A route could be built through ${best.title}, but nothing here could independently establish that it is correct.`, gaps: ranked, limitations: best.reasons };
  return { ...base, status: "gap-found", summary: `Missing transformation: ${best.title}.`, gaps: ranked };
}

async function consultRcx(universe: Universe, goal: Goal, sample: Buffer | undefined): Promise<Analysis["rcx"]> {
  if (!sample) return { plans: 0, note: "no input to compose from" };
  try {
    const text = sample.toString("utf8").slice(0, 4000);
    const anchors = goal.want.program ? [universe.tool(goal.want.program)?.id].filter((x): x is string => !!x) : [];
    const r = await universe.host.rc.compose({ have: { input: { type: "text", value: text } }, want: "text", intent: goal.intent, run: false, ...(anchors.length ? { through: anchors } : {}) });
    const best = r.plans[0];
    return {
      plans: r.plans.length,
      ...(best ? { best: best.titles.map((t) => t.slice(0, 50)).join(" -> ") } : {}),
      note: best ? "RightClick X found a type-level plan; its text ports say nothing about representation, so this is not evidence the route works" : "RightClick X found no type-level plan",
    };
  } catch (e) {
    return { plans: 0, note: `RightClick X composition refused: ${String((e as Error).message).slice(0, 160)}` };
  }
}

