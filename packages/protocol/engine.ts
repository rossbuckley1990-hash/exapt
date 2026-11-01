// The EXAPT engine: the one object the CLI, the HTTP service and the MCP server all drive. It owns
// the separation between the five parties in any invention: the planning model (proposes text), the
// orchestration runtime (this file), the generated program (behind the execution boundary), the
// verification oracles (programs and data that predate the candidate), and the operator's authority
// (configuration read at startup, never reachable from an agent-facing call).
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { RcxHost, ProgramChanged, type Capability } from "../rcx-adapter/index.ts";
import { Universe, reprLabel, accepted, type CapabilityNode, type EvidenceLevel, type GeneratedNodeInfo, type Goal, type SampleRef, type Tool, levelRank } from "../capability-universe/index.ts";
import { analyse, loadSample, type Analysis, type Gap } from "../gap-reasoner/index.ts";
import { dockerStatus, openBackend, reapOrphans, selfTest, DockerBackend, IMAGE, type ExecutionBackend, type SelfTestReport } from "../execution/index.ts";
import { invent, Judge, metamorphicChecks, runCases, specFor, TestBench, type BehaviouralContract, type CandidateAssessment, type EventSink, type InventionResult, type TestCase } from "../experiment-engine/index.ts";
import { Budget, modelFromEnv, type BudgetLimits, type ModelAdapter } from "../model-adapters/index.ts";
import { digest, newId, readJson, Refused, sha256, writeJson } from "../shared/index.ts";
import type { Candidate, Strategy } from "../synthesiser/index.ts";
import { verify, type EvidenceReport } from "../verification/index.ts";
import { evolve, evolutionHistory, type EvolutionAttempt, type Measurement, type Objective } from "../evolution/index.ts";
import { Vault, type CapabilityBundle, type CapabilityManifest, type ConsumerWitness, type Dependency, type ProgramDependency } from "../capability-memory/index.ts";

export interface ExaptConfig {
  home: string;
  /** Operator-authorised programs: exact paths or directories. */
  programs: string[];
  /** Who may turn verified evidence into an operation. "verified": it happens automatically.
   *  "operator": only the operator's own command does; an agent can never approve it. */
  publish: "verified" | "operator";
  strategy: Strategy;
  budget: BudgetLimits;
  model: ModelAdapter | null;
  backend?: ExecutionBackend;
  persistGraph?: boolean;
  /** Directories agent-supplied goals may name by path. Empty: inline data only. */
  dataRoots?: string[];
}

export type RunStatus = "queued" | "running" | "completed" | "failed" | "refused" | "unresolved";

export interface RunRecord {
  id: string;
  kind: "invent" | "evolve" | "repair";
  goal: Goal;
  base: string;
  status: RunStatus;
  stage: string;
  pid: number;
  startedAt: string;
  finishedAt?: string;
  analysis?: CompactAnalysis;
  gap?: string;
  contract?: BehaviouralContract;
  attempts: Array<Omit<CandidateAssessment, "source">>;
  accepted?: { sha256: string; producer: string; kind: string };
  evidence?: EvidenceReport;
  capability?: { id: string; version: number; status: string };
  workflow?: WorkflowResult;
  outcome: string;
  /** Synthesis statement: exactly what generated the accepted program. */
  synthesis?: { mode: "model" | "deterministic" | "test-double" | "none"; producer?: string };
  budget?: ReturnType<Budget["snapshot"]>;
  notes: string[];
  seed: number;
  /** Trimmed refutations, kept with the run. */
  counterexamples?: Array<{ problem: string; input: string }>;
}

export interface CompactGap {
  id: string;
  title: string;
  score: number;
  scores: Gap["scores"];
  oracles: string[];
  valueOracle: boolean;
  constructible: boolean;
  verifiable: boolean;
  worthAttempting: boolean;
  needsModel: boolean;
  missingInformation: string[];
  reasons: string[];
  minimumImplementation: string;
  evidenceNeeded: string[];
}

export type CompactAnalysis = Omit<Analysis, "gaps"> & { gaps: CompactGap[] };

export const compactGap = (g: Gap): CompactGap => ({
  id: g.id, title: g.title, score: Number(g.score.toFixed(3)), scores: g.scores, oracles: [...new Set(g.oracles.map((o) => o.kind))], valueOracle: g.oracles.some((o) => o.valueLevel),
  constructible: g.constructible, verifiable: g.verifiable, worthAttempting: g.worthAttempting, needsModel: g.needsModel, missingInformation: g.missingInformation, reasons: g.reasons,
  minimumImplementation: g.minimumImplementation, evidenceNeeded: g.evidenceNeeded,
});

export interface WorkflowResult {
  id: string;
  steps: Array<{ tool: string; kind: string; ok: boolean; ms: number; receipt?: string }>;
  output: string;
  ok: boolean;
}

export interface UseResult {
  capability: string;
  version: number;
  level: EvidenceLevel;
  output: string;
  outputBase64?: string;
  runId: string;
  receipt?: string;
  revalidation?: RevalidationResult;
  ms: number;
}

export type RevalidationResult = {
  id: string;
  version: number;
  outcome: "unchanged" | "compatible" | "incompatible" | "unavailable" | "accepted-import";
  changed: Array<{ program: string; from: string; to: string }>;
  checks: { passed: number; total: number };
  behaviourChanged: string[];
  reasons: string[];
  ms: number;
};

export interface Doctor {
  ok: boolean;
  checks: Array<{ name: string; status: "ok" | "warn" | "fail"; detail: string; next?: string }>;
  selfTest?: SelfTestReport;
}

/** Goals from agents and over HTTP carry their data inline. A path would let a caller read any file
 *  this process can read, so paths are refused unless they fall inside an operator-declared root. */
export function assertGoalSafe(goal: Goal, roots: string[]): void {
  const check = (s: SampleRef | undefined) => {
    if (!s?.path) return;
    const real = path.resolve(s.path);
    if (!path.isAbsolute(s.path) || !roots.some((r) => real === r || real.startsWith(`${r}/`))) throw new Refused("path-not-allowed", `goal refers to the file ${s.path}, which is outside the operator's data roots`, "Pass the data inline as text or base64.");
  };
  for (const s of goal.have?.samples ?? []) check(s);
  check(goal.want.sample);
  for (const e of goal.want.examples ?? []) {
    check(e.input);
    check(e.output);
  }
  for (const c of goal.corpus ?? []) {
    check(c.input);
    check(c.truth);
  }
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

export function configFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: Partial<ExaptConfig> = {}): ExaptConfig {
  const file = readJson<{ programs?: string[]; dataRoots?: string[]; publish?: ExaptConfig["publish"]; strategy?: Strategy; budget?: Partial<BudgetLimits> }>(env.EXAPT_CONFIG ?? path.join(process.cwd(), "exapt.config.json")) ?? {};
  const programs = env.EXAPT_PROGRAMS ? env.EXAPT_PROGRAMS.split(":").filter(Boolean) : file.programs ?? [];
  const numeric = (v: string | undefined, fallback: number) => (v !== undefined && Number.isFinite(Number(v)) ? Number(v) : fallback);
  return {
    home: env.EXAPT_HOME ?? path.join(process.cwd(), ".exapt"),
    programs,
    dataRoots: file.dataRoots ?? [],
    publish: (env.EXAPT_PUBLISH as ExaptConfig["publish"]) ?? file.publish ?? "verified",
    strategy: (env.EXAPT_STRATEGY as Strategy) ?? file.strategy ?? "auto",
    budget: {
      maxCalls: numeric(env.EXAPT_MAX_MODEL_CALLS, file.budget?.maxCalls ?? 12),
      maxTokens: numeric(env.EXAPT_MAX_TOKENS, file.budget?.maxTokens ?? 120_000),
      maxCostUsd: numeric(env.EXAPT_MAX_COST_USD, file.budget?.maxCostUsd ?? 2),
    },
    model: modelFromEnv(env),
    ...overrides,
  };
}

export class Exapt {
  readonly config: ExaptConfig;
  readonly host: RcxHost;
  readonly universe: Universe;
  readonly vault: Vault;
  readonly events = new EventEmitter();
  private backendCache?: ExecutionBackend;
  private discovered = false;

  private constructor(config: ExaptConfig, host: RcxHost) {
    this.config = config;
    this.host = host;
    this.universe = new Universe(host, config.home);
    this.vault = new Vault(config.home);
    this.events.setMaxListeners(64);
  }

  static async open(config: ExaptConfig): Promise<Exapt> {
    fs.mkdirSync(config.home, { recursive: true });
    const host = await RcxHost.open({ home: config.home, programs: config.programs, persist: config.persistGraph });
    const e = new Exapt(config, host);
    e.reconcileRuns();
    e.loadCapabilities();
    return e;
  }

  get backend(): ExecutionBackend {
    return (this.backendCache ??= this.config.backend ?? openBackend(process.env, path.join(this.config.home, "sandbox-attestation.json")));
  }

  // ---------------------------------------------------------- runs

  private runDir(id: string): string {
    return path.join(this.config.home, "runs", id);
  }

  private saveRun(r: RunRecord): void {
    writeJson(path.join(this.runDir(r.id), "run.json"), r);
  }

  run(id: string): RunRecord | undefined {
    return readJson<RunRecord>(path.join(this.runDir(id), "run.json"));
  }

  runs(limit = 50): RunRecord[] {
    const dir = path.join(this.config.home, "runs");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).sort().reverse().slice(0, limit).flatMap((id) => {
      const r = this.run(id);
      return r ? [r] : [];
    });
  }

  runEvents(id: string): Array<Record<string, unknown>> {
    const file = path.join(this.runDir(id), "events.jsonl");
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  }

  /** Work a dead process left behind stays visibly unresolved. It is neither failed nor finished. */
  private reconcileRuns(): void {
    for (const r of this.runs(200)) {
      if (r.status !== "running" && r.status !== "queued") continue;
      if (r.pid !== process.pid && !alive(r.pid)) {
        r.status = "unresolved";
        r.stage = `${r.stage} (the process running this ended before it finished)`;
        r.outcome = "unresolved: no result was recorded, so nothing is claimed about this run";
        this.saveRun(r);
      }
    }
  }

  private sink(run: RunRecord): EventSink {
    const file = path.join(this.runDir(run.id), "events.jsonl");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return (type, data) => {
      const e = { at: new Date().toISOString(), run: run.id, type, ...data };
      fs.appendFileSync(file, `${JSON.stringify(e)}\n`);
      this.events.emit("event", e);
    };
  }

  // ---------------------------------------------------------- discovery

  async discover(opts: { seeds?: string[]; refresh?: boolean } = {}): Promise<{ programs: number; learned: string[]; unusable: string[] }> {
    const r = await this.universe.discover(opts);
    this.discovered = true;
    this.loadCapabilities();
    return r;
  }

  private async ensureDiscovered(): Promise<void> {
    if (!this.discovered) await this.discover();
  }

  summary(opts: { query?: string; status?: CapabilityNode["status"]; limit?: number } = {}) {
    const nodes = this.universe.search(opts.query ?? "", { status: opts.status, limit: opts.limit ?? 15 });
    const all = this.universe.nodes();
    const count = (s: string) => all.filter((n) => n.status === s).length;
    return {
      counts: { total: all.length, existing: count("existing"), candidateMissing: count("candidate-missing"), unverified: count("synthesised-unverified"), verified: count("verified-within-scope"), invalidated: count("invalidated"), refused: count("refused") },
      programs: this.universe.usable().filter((t) => t.kind === "program").map((t) => ({ id: t.id, name: t.name, accepts: t.contract.input ? reprLabel(t.contract.input.repr) : null, produces: t.contract.output ? reprLabel(t.contract.output.repr) : null })),
      nodes: nodes.map((n) => ({ id: n.id, status: n.status, title: n.title.slice(0, 80), input: n.inputs[0]?.repr ?? n.inputs[0]?.semantic, output: n.outputs[0]?.repr ?? n.outputs[0]?.semantic, level: n.verification.level })),
    };
  }

  // ---------------------------------------------------------- analysis

  async analyse(goal: Goal, base: string): Promise<Analysis> {
    await this.ensureDiscovered();
    return analyse(this.universe, goal, { base, modelAvailable: !!this.config.model && this.config.strategy !== "deterministic-only" });
  }

  async analyseCompact(goal: Goal, base: string): Promise<CompactAnalysis> {
    const a = await this.analyse(goal, base);
    return { ...a, gaps: a.gaps.map(compactGap) };
  }

  // ---------------------------------------------------------- invention

  private budgetFor(goal: Goal): Budget {
    const b = this.config.budget;
    return new Budget({ maxCalls: Math.min(b.maxCalls, goal.budget?.modelCalls ?? b.maxCalls), maxTokens: Math.min(b.maxTokens, goal.budget?.maxTokens ?? b.maxTokens), maxCostUsd: Math.min(b.maxCostUsd, goal.budget?.maxCostUsd ?? b.maxCostUsd) });
  }

  /** Verified capabilities usable as building blocks in the next synthesis. */
  private helpers(): { helpers: Array<{ name: string; purpose: string }>; libs: Record<string, string> } {
    const helpers: Array<{ name: string; purpose: string }> = [];
    const libs: Record<string, string> = {};
    for (const s of this.vault.list()) {
      const m = this.vault.manifest(s.id);
      if (m?.status !== "verified-within-scope") continue;
      helpers.push({ name: m.id, purpose: `${m.inputs[0]?.representation} -> ${m.outputs[0]?.representation}` });
      libs[m.id] = this.vault.source(m);
    }
    return { helpers, libs };
  }

  private assertBoundary(): void {
    if (this.config.backend) return;
    const d = dockerStatus();
    if (!d.available || !d.imagePresent) throw new Refused("sandbox-unavailable", `generated programs cannot run here: ${d.detail}`, d.available ? "Run `npm run setup` to fetch the pinned sandbox image." : "Install and start Docker. Generated code is refused rather than run without containment.");
  }

  /** Start an invention. Returns at once with `wait: false`; progress is in the run's events. */
  async startInvention(goal: Goal, base: string, opts: { wait?: boolean; publish?: boolean; seed?: number; strategy?: Strategy; gap?: string; injected?: Candidate[]; rounds?: number } = {}): Promise<RunRecord> {
    this.assertBoundary();
    const run: RunRecord = {
      id: newId("run"), kind: "invent", goal, base, status: "queued", stage: "queued", pid: process.pid, startedAt: new Date().toISOString(),
      attempts: [], outcome: "in progress", notes: [], seed: opts.seed ?? Math.floor(Math.random() * 1e9),
    };
    fs.mkdirSync(this.runDir(run.id), { recursive: true });
    this.saveRun(run);
    const work = this.executeInvention(run, opts).catch((e) => {
      run.status = e instanceof Refused ? "refused" : "failed";
      run.outcome = String(e.message ?? e);
      run.finishedAt = new Date().toISOString();
      this.saveRun(run);
      this.sink(run)("run.failed", { error: run.outcome });
      return run;
    });
    if (opts.wait === false) return run;
    return work;
  }

  private async executeInvention(run: RunRecord, opts: { publish?: boolean; strategy?: Strategy; gap?: string; injected?: Candidate[]; rounds?: number }): Promise<RunRecord> {
    const emit = this.sink(run);
    const stage = (s: string) => {
      run.stage = s;
      this.saveRun(run);
      emit("stage", { stage: s });
    };
    run.status = "running";
    stage("analysing");
    const analysis = await this.analyse(run.goal, run.base);
    run.analysis = { ...analysis, gaps: analysis.gaps.map(compactGap) };
    emit("analysis", { status: analysis.status, summary: analysis.summary, gaps: analysis.gaps.slice(0, 5).map(compactGap), reachable: analysis.reachable, required: analysis.required, rcx: analysis.rcx });
    if (analysis.status !== "gap-found") {
      run.status = analysis.status === "achievable-existing" || analysis.status === "achievable-composition" ? "completed" : "refused";
      run.outcome = analysis.summary;
      if (analysis.route) run.workflow = await this.executeRoute(analysis.route.steps.map((s) => ({ tool: s.tool, args: s.args })), run.goal, run.base);
      return this.finish(run, emit);
    }
    const gap = opts.gap ? analysis.gaps.find((g) => g.id === opts.gap) : analysis.gaps.find((g) => g.worthAttempting);
    if (!gap) {
      const top = analysis.gaps[0];
      run.status = "refused";
      run.outcome = `No gap is worth attempting: ${top.reasons.join("; ") || "no constructible gap has an oracle"}`;
      return this.finish(run, emit);
    }
    run.gap = gap.id;
    stage("synthesising and falsifying");
    const budget = this.budgetFor(run.goal);
    const modelLog = path.join(this.runDir(run.id), "model.jsonl");
    const { helpers, libs } = this.helpers();
    const result = await invent({
      universe: this.universe, goal: run.goal, gap, base: run.base, backend: this.backend, model: this.config.model, budget, strategy: opts.strategy ?? this.config.strategy,
      seed: run.seed, helpers, libs, injected: opts.injected, rounds: opts.rounds, onEvent: emit,
      onModelCall: (entry) => fs.appendFileSync(modelLog, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`),
    });
    run.contract = result.contract;
    run.counterexamples = result.counterexamples.slice(-12).map((c) => ({ problem: c.problem.slice(0, 300), input: c.binary ? "(binary)" : c.input.slice(0, 400) }));
    run.notes = [...new Set(result.notes)];
    run.budget = budget.snapshot();
    run.attempts = result.attempts.map(({ source, ...a }) => a);
    for (const a of result.attempts) {
      const hash = this.vault.put(a.source ?? "");
      if (!a.survived) this.vault.record({ run: run.id, gap: gap.id, producer: a.candidate.producer, kind: a.candidate.kind, level: a.level, rejectedAt: a.rejectedAt ?? "?", reason: (a.reason ?? "").slice(0, 400), sha256: hash });
    }
    if (result.accepted) this.vault.put(result.accepted.source);
    if (result.status !== "accepted" || !result.accepted) {
      run.status = "completed";
      run.outcome = `Not established: ${result.reason}`;
      run.synthesis = { mode: "none" };
      if (result.best?.source && levelRank(result.best.level) >= levelRank("passed-visible")) this.retainUnverified(run, result, gap);
      return this.finish(run, emit);
    }
    const accepted = result.accepted;
    run.accepted = { sha256: accepted.sha256, producer: accepted.producer, kind: accepted.kind };
    run.synthesis = accepted.kind === "model" ? { mode: "model", producer: accepted.producer } : accepted.kind === "test-double" ? { mode: "test-double", producer: accepted.producer } : { mode: "deterministic", producer: accepted.producer };
    stage("verifying independently");
    const evidence = await verify({ universe: this.universe, contract: result.contract, bench: new TestBench({ universe: this.universe, goal: run.goal, gap, contract: result.contract, base: run.base, seed: run.seed + 104729 }), backend: this.backend, source: accepted.source, producer: accepted.producer, kind: accepted.kind, seed: run.seed + 104729, libs });
    run.evidence = evidence;
    emit("verified", { level: evidence.level, tiers: evidence.tiers, mutation: evidence.mutation, assessment: evidence.assessment });
    if (opts.publish === false || this.config.publish === "operator") {
      run.status = "completed";
      run.outcome = `Candidate awaits publication: ${evidence.assessment}`;
      return this.finish(run, emit);
    }
    stage("publishing");
    await this.publishCandidate(run, result, gap, accepted, evidence, libs);
    if (run.capability?.status === "verified-within-scope") {
      this.universe.closeGoal(run.goal.id);
      stage("running the completed workflow");
      const steps = [...gap.from.lineage, { tool: run.capability.id }, ...gap.to.downstream.map((tool) => ({ tool }))];
      run.workflow = await this.executeRoute(steps, run.goal, run.base);
      this.saveWorkflow(run);
      emit("workflow", { ok: run.workflow.ok, steps: run.workflow.steps, output: run.workflow.output.slice(0, 2000) });
    }
    run.status = "completed";
    return this.finish(run, emit);
  }

  private finish(run: RunRecord, emit: EventSink): RunRecord {
    run.finishedAt = new Date().toISOString();
    run.stage = "finished";
    this.saveRun(run);
    emit("run.finished", { status: run.status, outcome: run.outcome, capability: run.capability });
    return run;
  }

  private dependencies(contract: BehaviouralContract, libs: Record<string, string>): Dependency[] {
    const out: Dependency[] = [];
    const add = (id: string, role: ProgramDependency["role"]) => {
      const t = this.universe.tool(id);
      if (t?.ref) {
        if (!out.some((d) => d.kind === "program" && d.capability === t.id)) out.push({ kind: "program", role, capability: t.id, name: t.name, sha256: t.ref.sha256, behaviour: t.contract.behaviour });
      } else if (t?.kind === "generated") {
        const m = this.vault.manifest(t.id);
        if (m) out.push({ kind: "capability", id: m.id, version: m.version, sha256: m.artefact.sha256 });
      }
    };
    for (const id of contract.upstream) add(id, "upstream");
    if (contract.consumer) add(contract.consumer, "consumer");
    for (const o of contract.oracles) if (o.kind === "inverse-route") for (const id of o.route) add(id, "oracle");
    void libs;
    return out;
  }

  private async conformanceSuite(bench: TestBench, source: string, contract: BehaviouralContract, libs: Record<string, string>): Promise<{ cases: TestCase[]; witnesses: ConsumerWitness[] }> {
    const cases = [...await bench.visible(), ...await bench.independent(5000), ...await bench.boundary(), ...bench.malformed()];
    const witnesses: ConsumerWitness[] = [];
    if (contract.consumer) {
      const consumer = this.universe.tool(contract.consumer)!;
      for (const c of cases.filter((x) => x.tier !== "malformed" && !x.binary).slice(0, 8)) {
        const r = await this.backend.run({ source, input: c.input, libs });
        if (r.status !== "ok" || r.output === undefined) continue;
        const out = await consumer.run(r.output);
        if (accepted(out)) witnesses.push({ caseId: c.id, outputDigest: sha256(out.stdout) });
      }
    }
    return { cases, witnesses };
  }

  private capabilityId(contract: BehaviouralContract): string {
    const to = contract.consumer ? slugify(this.universe.tool(contract.consumer)?.name ?? "target") : contract.target.repr.syntax.format;
    return `exapt:${contract.source.repr.syntax.format}-to-${to}-${digest([contract.source.label, contract.target.label]).slice(0, 6)}`;
  }

  private manifestFor(run: RunRecord, result: InventionResult, accepted: Candidate, evidence: EvidenceReport, status: CapabilityManifest["status"], suite: { cases: TestCase[]; witnesses: ConsumerWitness[] }, libs: Record<string, string>): CapabilityManifest {
    const { contract } = result;
    const id = this.capabilityId(contract);
    const artefact = this.vault.put(accepted.source);
    const version = this.vault.nextVersion(id);
    return {
      format: "exapt/capability@1", id, version, status,
      title: `${contract.source.label} -> ${contract.target.label}`,
      purpose: run.goal.intent,
      inputs: [{ name: "input", representation: contract.source.label, semantic: contract.inputKind === "binary" ? "bytes" : "text" }],
      outputs: [{ name: "output", representation: contract.target.label, semantic: "text" }],
      artefact: { sha256: artefact, language: "javascript-esm", entry: "transform", bytes: Buffer.byteLength(accepted.source) },
      contract,
      dependencies: this.dependencies(contract, libs),
      environment: { runtime: "node 22", image: IMAGE, backend: this.backend.name },
      permissions: { network: false, filesystem: "none", risk: "read" },
      evidence,
      limitations: evidence.limitations,
      counterexamples: result.counterexamples.slice(-12).map((c) => ({ problem: c.problem.slice(0, 300), input: c.binary ? "(binary)" : c.input.slice(0, 400) })),
      rejected: result.attempts.filter((a) => !a.survived).map((a) => ({ producer: a.candidate.producer, rejectedAt: a.rejectedAt ?? "?", reason: (a.reason ?? "").slice(0, 300) })),
      provenance: { goal: run.goal.id, run: run.id, producer: accepted.producer, kind: accepted.kind, real: accepted.kind === "model", createdAt: new Date().toISOString() },
      revalidation: { suite: this.vault.put(JSON.stringify({ cases: suite.cases })), witnesses: suite.witnesses, instructions: "Re-run the stored suite through the pinned oracles; compare the consumer's outputs with the stored witnesses." },
      receipts: [],
    };
  }

  private async publishCandidate(run: RunRecord, result: InventionResult, gap: Gap, accepted: Candidate, evidence: EvidenceReport, libs: Record<string, string>): Promise<void> {
    const allowed = evidence.level === "verified-in-domain";
    const bench = new TestBench({ universe: this.universe, goal: run.goal, gap, contract: result.contract, base: run.base, seed: run.seed + 7 });
    const suite = await this.conformanceSuite(bench, accepted.source, result.contract, libs);
    if (!allowed) {
      const m = this.manifestFor(run, result, accepted, evidence, "synthesised-unverified", suite, libs);
      this.vault.retain(m);
      this.universe.generated.set(m.id, this.nodeInfo(m));
      run.capability = { id: m.id, version: m.version, status: m.status };
      run.outcome = `Retained as unverified (${evidence.level}): ${evidence.assessment}`;
      return;
    }
    const m = this.manifestFor(run, result, accepted, evidence, "verified-within-scope", suite, libs);
    this.vault.retain(m);
    this.activate(m);
    run.capability = { id: m.id, version: m.version, status: m.status };
    run.outcome = `New capability ${m.id}@${m.version}: ${evidence.assessment}`;
  }

  private retainUnverified(run: RunRecord, result: InventionResult, gap: Gap): void {
    const best = result.best!;
    const cand: Candidate = { ...(best.candidate as Candidate), source: best.source! };
    const evidence: EvidenceReport = {
      format: "exapt/evidence@1", candidate: { sha256: sha256(cand.source), producer: cand.producer, kind: cand.kind }, level: best.level, checkedAt: new Date().toISOString(), seed: run.seed,
      tiers: best.tiers as EvidenceReport["tiers"], oracles: [], metamorphic: { passed: 0, total: 0, failures: [] }, mutation: { killed: 0, total: 0, value: { killed: 0, total: 0 }, survivors: [] }, domain: [], limitations: [`Rejected at ${best.rejectedAt}: ${best.reason}`], assessment: `Best attempt reached ${best.level}; it is retained for inspection only and cannot be invoked.`,
      execution: { backend: this.backend.name, enforces: this.backend.enforces, notEstablished: this.backend.notEstablished }, failures: best.failures,
    };
    const m = this.manifestFor(run, result, cand, evidence, "synthesised-unverified", { cases: [], witnesses: [] }, {});
    this.vault.retain(m);
    this.universe.generated.set(m.id, this.nodeInfo(m));
    run.capability = { id: m.id, version: m.version, status: m.status };
    void gap;
  }

  private nodeInfo(m: CapabilityManifest): GeneratedNodeInfo {
    return {
      id: m.id, version: m.version, status: m.status, title: m.title, level: m.evidence.level, from: m.inputs[0].representation, to: m.outputs[0].representation,
      oracles: m.evidence.oracles.map((o) => o.name), dependencies: m.dependencies.map((d) => (d.kind === "program" ? { id: d.capability, pin: d.sha256 } : { id: d.id, pin: d.sha256 })), limitations: m.limitations,
    };
  }

  /** A verified capability becomes a real operation in both graphs. */
  private activate(m: CapabilityManifest): void {
    const source = this.vault.source(m);
    const libs = this.libsFor(m);
    const kind = m.contract.inputKind;
    const repr = m.contract.target.repr;
    const tool: Tool = {
      id: m.id, name: m.id, kind: "generated", version: m.version,
      contract: { tool: m.id, name: m.id, docs: m.purpose, input: { repr: m.contract.source.repr, requiredFields: m.contract.source.repr.fields.map((f) => f.name), optionalFields: [], influentialFields: [], positive: kind === "text" ? [m.contract.source.sample] : [], rejected: [] }, output: { repr, example: m.contract.target.sample.slice(0, 2000) }, options: [], behaviour: m.artefact.sha256, claims: [], probes: 0 },
      run: async (input) => {
        const r = await this.backend.run({ source, input, libs });
        return { ok: r.status === "ok", stdout: r.output ?? "", stderr: r.error ?? "", ms: r.ms, code: r.status === "ok" ? 0 : 1 };
      },
    };
    this.universe.addGenerated(tool, this.nodeInfo(m));
    const cap: Capability = {
      id: m.id, title: m.title, description: `${m.purpose}. Generated by EXAPT; ${m.evidence.level}. ${m.evidence.assessment}`.slice(0, 400), provider: "exapt:vault", source: "builtin",
      inputs: [{ name: "input", type: "text", required: true, anyText: true, description: `Value of representation ${m.inputs[0].representation}` }, { name: "encoding", type: "text", required: false, description: "\"base64\" when input is base64 of binary data" }],
      outputs: [{ name: "", type: "text", required: true }], risk: "read", tags: ["exapt", "generated", m.evidence.level], invoke: { kind: "builtin", fn: `exapt.${m.id}` },
    };
    this.host.registerOperation(cap, async (args) => {
      const input = args.encoding === "base64" ? Buffer.from(String(args.input), "base64") : String(args.input ?? "");
      const r = await this.backend.run({ source, input, libs });
      if (r.status !== "ok") throw new Error(`${r.status}: ${r.error ?? "no output"}`);
      return r.output ?? r.outputBase64;
    }, { id: "exapt:vault", title: "Capabilities EXAPT acquired", source: "builtin", origin: "exapt", learnedAt: new Date().toISOString() });
  }

  private libsFor(m: CapabilityManifest): Record<string, string> {
    const libs: Record<string, string> = {};
    for (const d of m.dependencies) {
      if (d.kind !== "capability") continue;
      const dep = this.vault.manifest(d.id, d.version);
      if (dep) libs[d.id] = this.vault.source(dep);
    }
    return libs;
  }

  /** On every start, retained verified capabilities become operations again. */
  private loadCapabilities(): void {
    for (const s of this.vault.list()) {
      const m = this.vault.manifest(s.id);
      if (!m) continue;
      if (m.status === "verified-within-scope") {
        this.activate(m);
      } else {
        this.universe.generated.set(m.id, this.nodeInfo(m));
        this.host.retireOperation(m.id);
      }
    }
  }

  // ---------------------------------------------------------- workflows

  private saveWorkflow(run: RunRecord): void {
    if (!run.workflow) return;
    writeJson(path.join(this.config.home, "workflows", `${slugify(run.goal.id)}.json`), { goal: run.goal.id, intent: run.goal.intent, steps: run.workflow.steps.map((s) => s.tool), capability: run.capability });
  }

  workflows(): Array<{ goal: string; intent: string; steps: string[] }> {
    const dir = path.join(this.config.home, "workflows");
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).map((f) => readJson<{ goal: string; intent: string; steps: string[] }>(path.join(dir, f))!);
  }

  async runWorkflow(goalId: string, input: string): Promise<WorkflowResult> {
    await this.ensureDiscovered();
    const w = readJson<{ steps: string[] }>(path.join(this.config.home, "workflows", `${slugify(goalId)}.json`));
    if (!w) throw new Refused("unknown-workflow", `no retained workflow for ${goalId}`);
    return this.runSteps(w.steps.map((tool) => ({ tool })), input);
  }

  private async executeRoute(steps: Array<{ tool: string; args?: string[] }>, goal: Goal, base: string): Promise<WorkflowResult> {
    const sample = goal.have?.samples?.[0] ?? goal.want.examples?.[0]?.input ?? goal.corpus?.[0]?.input;
    return this.runSteps(steps, sample ? loadSample(sample, base).toString("utf8") : "");
  }

  private async runSteps(steps: Array<{ tool: string; args?: string[] }>, input: string): Promise<WorkflowResult> {
    const out: WorkflowResult["steps"] = [];
    let value = input;
    for (const step of steps) {
      const t = this.universe.tool(step.tool);
      if (!t) {
        out.push({ tool: step.tool, kind: "unavailable", ok: false, ms: 0 });
        return { id: newId("wf"), steps: out, output: "", ok: false };
      }
      if (t.kind === "generated") await this.assertUsable(t.id);
      const t0 = performance.now();
      const useRcx = !step.args?.length;
      const rec = useRcx ? await this.host.rc.run(t.id, { input: value }).catch((e) => ({ status: "failed" as const, output: undefined, error: String(e.message), receipt: undefined })) : null;
      const direct = rec ? null : await t.run(value, { args: step.args });
      const ok = rec ? rec.status === "completed" && typeof rec.output === "string" : !!direct && accepted(direct);
      const receipt = (rec as { receipt?: { hash?: string } } | null)?.receipt?.hash;
      out.push({ tool: t.id, kind: t.kind, ok, ms: Math.round(performance.now() - t0), ...(receipt ? { receipt } : {}) });
      if (!ok) return { id: newId("wf"), steps: out, output: "", ok: false };
      value = rec ? String(rec.output) : direct!.stdout;
    }
    return { id: newId("wf"), steps: out, output: value, ok: true };
  }

  // ---------------------------------------------------------- use and revalidation

  private async assertUsable(id: string): Promise<RevalidationResult | undefined> {
    const m = this.vault.manifest(id);
    if (!m) throw new Refused("unknown-capability", `no retained capability ${id}`, "Search with exapt_memory.");
    if (m.status !== "verified-within-scope") throw new Refused("not-verified", `${id}@${m.version} is ${m.status}: ${this.vault.state(id)?.versions.find((v) => v.version === m.version)?.reason ?? m.evidence.assessment}`);
    const changed = this.changedDependencies(m);
    if (!changed.length) return undefined;
    const r = await this.revalidate(id);
    if (r.outcome === "incompatible" || r.outcome === "unavailable") throw new Refused("dependency-changed", `${id}@${m.version} refused: ${r.reasons.join("; ")}`, "The capability stays invalidated until it is repaired or an operator re-establishes it.");
    return r;
  }

  private changedDependencies(m: CapabilityManifest): Array<{ program: string; from: string; to: string }> {
    const out: Array<{ program: string; from: string; to: string }> = [];
    for (const d of m.dependencies) {
      if (d.kind !== "program") continue;
      const bin = this.host.authorisedPrograms().find((p) => path.basename(p) === d.name.split(" ")[0]);
      const now = bin ? this.host.programHash(bin) : "(absent)";
      if (now !== d.sha256) out.push({ program: d.name, from: d.sha256.slice(0, 12), to: now.slice(0, 12) });
    }
    return out;
  }

  async use(id: string, input: string, opts: { encoding?: "base64"; version?: number } = {}): Promise<UseResult> {
    await this.ensureDiscovered();
    const clean = id.replace(/@(\d+)$/, "");
    const asked = /@(\d+)$/.exec(id)?.[1];
    const version = opts.version ?? (asked ? Number(asked) : undefined);
    const revalidation = await this.assertUsable(clean);
    const m = this.vault.manifest(clean, version)!;
    if (m.status !== "verified-within-scope") throw new Refused("not-verified", `${clean}@${m.version} is ${m.status}`);
    const t0 = performance.now();
    if (version !== undefined && version !== this.vault.state(clean)?.current) {
      const r = await this.backend.run({ source: this.vault.source(m), input: opts.encoding === "base64" ? Buffer.from(input, "base64") : input, libs: this.libsFor(m) });
      if (r.status !== "ok") throw new Refused("execution-failed", `${r.status}: ${r.error}`);
      return { capability: clean, version: m.version, level: m.evidence.level, output: r.output ?? "", runId: "direct", ms: Math.round(performance.now() - t0), ...(revalidation ? { revalidation } : {}) };
    }
    const rec = await this.host.rc.run(clean, { input, ...(opts.encoding ? { encoding: opts.encoding } : {}) });
    if (rec.status !== "completed") throw new Refused("execution-failed", `${clean} refused this input: ${rec.error ?? rec.status}`, "The capability's verified domain is stated by exapt_explain.");
    const receipt = (rec as unknown as { receipt?: { hash?: string } }).receipt?.hash;
    if (receipt) this.vault.addReceipt(m, receipt);
    return { capability: clean, version: m.version, level: m.evidence.level, output: String(rec.output ?? ""), runId: rec.runId, ...(receipt ? { receipt } : {}), ms: Math.round(performance.now() - t0), ...(revalidation ? { revalidation } : {}) };
  }

  /** Establish again, on this host, today, whether a capability's evidence still holds. */
  async revalidate(id: string): Promise<RevalidationResult> {
    const t0 = performance.now();
    const clean = id.replace(/@\d+$/, "");
    const m = this.vault.manifest(clean);
    if (!m) throw new Refused("unknown-capability", `no retained capability ${clean}`);
    const changed = this.changedDependencies(m);
    const imported = !!m.provenance.importedFrom && m.status !== "verified-within-scope";
    const base = { id: clean, version: m.version, changed, ms: 0 };
    if (!changed.length && !imported) return { ...base, outcome: "unchanged", checks: { passed: 0, total: 0 }, behaviourChanged: [], reasons: [], ms: Math.round(performance.now() - t0) };
    await this.discover();
    const judge = new Judge(this.universe, m.contract);
    const absent = m.dependencies.filter((d) => d.kind === "program" && !this.universe.tool(d.name));
    if (absent.length) {
      const reasons = [`program(s) not available here: ${absent.map((d) => (d as ProgramDependency).name).join(", ")}`];
      this.invalidate(m, reasons[0]);
      return { ...base, outcome: "unavailable", checks: { passed: 0, total: 0 }, behaviourChanged: [], reasons, ms: Math.round(performance.now() - t0) };
    }
    const contract = this.localise(m.contract);
    const localJudge = new Judge(this.universe, contract);
    void judge;
    const source = this.vault.source(m);
    const libs = this.libsFor(m);
    const suite = this.vault.suite(m);
    const results = await runCases(this.backend, localJudge, source, suite.cases, libs);
    const reasons = results.filter((r) => !r.passed).slice(0, 4).flatMap((r) => r.failures.slice(0, 1).map((f) => `${r.tier} ${f.oracle}: ${f.detail}`));
    const behaviourChanged: string[] = [];
    if (contract.consumer) {
      const consumer = this.universe.tool(contract.consumer)!;
      for (const w of m.revalidation.witnesses) {
        const c = suite.cases.find((x) => x.id === w.caseId);
        if (!c) continue;
        const r = await this.backend.run({ source, input: c.input, libs });
        const out = r.output !== undefined ? await consumer.run(r.output) : null;
        if (!out || !accepted(out) || sha256(out.stdout) !== w.outputDigest) behaviourChanged.push(`${consumer.name} answers ${c.id} differently`);
      }
    }
    const passed = results.filter((r) => r.passed).length;
    const checks = { passed, total: results.length };
    if (reasons.length || behaviourChanged.length) {
      const why = [...reasons, ...(behaviourChanged.length ? [`${behaviourChanged.length} of ${m.revalidation.witnesses.length} behaviour witnesses changed`] : [])];
      this.invalidate(m, why[0]);
      return { ...base, outcome: "incompatible", checks, behaviourChanged, reasons: why, ms: Math.round(performance.now() - t0) };
    }
    const dependencies = m.dependencies.map((d) => {
      if (d.kind !== "program") return d;
      const t = this.universe.tool(d.name);
      return t?.ref ? { ...d, capability: t.id, sha256: t.ref.sha256, behaviour: t.contract.behaviour } : d;
    });
    if (imported) {
      const here: CapabilityManifest = { ...m, dependencies, contract, status: "verified-within-scope" };
      this.vault.retain(here);
      this.vault.setStatus(m.id, m.version, "verified-within-scope", `every check reproduced on this host (${passed}/${results.length})`);
      this.activate(this.vault.manifest(m.id)!);
      return { ...base, outcome: "accepted-import", checks, behaviourChanged, reasons: [], ms: Math.round(performance.now() - t0) };
    }
    this.vault.repin(m, dependencies, `compatible: ${changed.map((c) => `${c.program} ${c.from} -> ${c.to}`).join(", ")}; ${passed}/${results.length} checks and all behaviour witnesses held`);
    return { ...base, outcome: "compatible", checks, behaviourChanged, reasons: [], ms: Math.round(performance.now() - t0) };
  }

  /** Program ids in a contract refer to names; re-point them at this host's tools. */
  private localise(c: BehaviouralContract): BehaviouralContract {
    const local = (id: string) => this.universe.tool(id)?.id ?? this.universe.tool(id.replace(/^cli:|:mined$/g, ""))?.id ?? id;
    return {
      ...c,
      consumer: c.consumer ? local(c.consumer) : null,
      upstream: c.upstream.map(local),
      oracles: c.oracles.map((o) => (o.kind === "inverse-route" ? { ...o, route: o.route.map(local) } : o.kind === "consumer-acceptance" ? { ...o, tool: local(o.tool) } : o)),
    };
  }

  private invalidate(m: CapabilityManifest, reason: string): void {
    this.vault.setStatus(m.id, m.version, "invalidated", reason);
    const after = this.vault.manifest(m.id, m.version);
    if (after) this.universe.generated.set(m.id, this.nodeInfo(after));
    this.universe.removeGenerated(m.id);
    this.host.retireOperation(m.id);
    for (const dep of this.vault.dependents(m.id)) this.invalidate(dep, `depends on ${m.id}@${m.version}, which was invalidated`);
  }

  // ---------------------------------------------------------- explicit lifecycle steps

  private async rehydrate(id: string): Promise<{ run: RunRecord; gap: Gap; contract: BehaviouralContract; source: string }> {
    const run = this.run(id);
    if (!run) throw new Refused("unknown-run", `no run ${id}`);
    if (!run.accepted || !run.contract) throw new Refused("no-candidate", `run ${id} has no surviving candidate to work with (${run.outcome})`);
    const contract = this.localise(run.contract);
    const analysis = await this.analyse(run.goal, run.base);
    const gap = analysis.gaps.find((g) => g.id === run.gap);
    if (!gap) throw new Refused("gap-closed", `the gap this run addressed no longer exists here: ${analysis.summary}`);
    return { run, gap, contract, source: this.vault.get(run.accepted.sha256).toString("utf8") };
  }

  /** Another round of falsification on a run's candidate, from a fresh seed. */
  async experiment(id: string, opts: { seed?: number } = {}) {
    const { run, gap, contract, source } = await this.rehydrate(id);
    const seed = opts.seed ?? Math.floor(Math.random() * 1e9);
    const bench = new TestBench({ universe: this.universe, goal: run.goal, gap, contract, base: run.base, seed });
    const judge = new Judge(this.universe, contract);
    const { libs } = this.helpers();
    const cases = [...await bench.independent(1), ...await bench.boundary(), ...bench.malformed(), ...await bench.holdout(1)];
    const results = await runCases(this.backend, judge, source, cases, libs);
    const meta = await metamorphicChecks(this.backend, source, contract, cases.filter((c) => c.tier === "independent"), seed, libs);
    const failed = results.filter((r) => !r.passed);
    this.sink(run)("experiment", { seed, passed: results.length - failed.length, total: results.length });
    return { run: id, seed, passed: results.length - failed.length, total: results.length, metamorphic: { passed: meta.results.filter((m) => m.passed).length, total: meta.results.length }, failures: failed.slice(0, 5).flatMap((r) => r.failures.slice(0, 1).map((f) => ({ tier: r.tier, oracle: f.oracle, detail: f.detail.slice(0, 240) }))), note: "No failure here is evidence of correctness outside these inputs." };
  }

  /** A fresh, complete, independent assessment of a run's candidate. */
  async verifyRun(id: string): Promise<EvidenceReport> {
    const { run, gap, contract, source } = await this.rehydrate(id);
    const seed = Math.floor(Math.random() * 1e9);
    const { libs } = this.helpers();
    const evidence = await verify({ universe: this.universe, contract, bench: new TestBench({ universe: this.universe, goal: run.goal, gap, contract, base: run.base, seed }), backend: this.backend, source, producer: run.accepted!.producer, kind: run.accepted!.kind, seed, libs });
    run.evidence = evidence;
    this.saveRun(run);
    return evidence;
  }

  /** Publication. `operator` is set only by the operator's own command line, never by a tool call. */
  async publishRun(id: string, actor: "agent" | "operator"): Promise<RunRecord> {
    if (actor === "agent" && this.config.publish === "operator") throw new Refused("operator-approval-required", "this installation publishes only by the operator's own command", "The operator can run `exapt publish <run-id>`.");
    const { run, gap, contract, source } = await this.rehydrate(id);
    if (!run.evidence) throw new Refused("not-verified", "this run has no verification report yet", "Call exapt_verify first.");
    if (run.capability?.status === "verified-within-scope") return run;
    const { libs } = this.helpers();
    const result = { contract, attempts: [], counterexamples: [] } as unknown as InventionResult;
    const accepted: Candidate = { id: run.accepted!.sha256.slice(0, 12), source, sha256: run.accepted!.sha256, kind: run.accepted!.kind as Candidate["kind"], round: 0, producer: run.accepted!.producer, explanation: [] };
    await this.publishCandidate(run, result, gap, accepted, run.evidence, libs);
    this.saveRun(run);
    return run;
  }

  // ---------------------------------------------------------- evolution and repair

  /** A bounded improvement attempt. Only a new version of a generated artefact can result. */
  async evolve(id: string, objective: Objective, opts: { maxCandidates?: number } = {}): Promise<EvolutionAttempt> {
    await this.ensureDiscovered();
    const clean = id.replace(/@\d+$/, "");
    const m = this.vault.manifest(clean);
    if (!m) throw new Refused("unknown-capability", `no retained capability ${clean}`);
    await this.assertUsable(clean);
    this.assertBoundary();
    const contract = this.localise(m.contract);
    const budget = new Budget(this.config.budget);
    const attempt = await evolve({
      universe: this.universe, vault: this.vault, backend: this.backend, model: this.config.strategy === "deterministic-only" ? null : this.config.model, budget, home: this.config.home, libs: this.libsFor(m),
      contractFor: () => contract, specFor: () => specFor(this.universe, contract, m.purpose),
      promote: (base, source, record, measured) => this.promote(base, source, record, measured),
    }, m, objective, opts);
    return attempt;
  }

  private async promote(base: CapabilityManifest, source: string, record: EvolutionAttempt, measured: Measurement): Promise<CapabilityManifest> {
    const contract = this.localise(base.contract);
    const run = this.runs(200).find((r) => r.id === base.provenance.run);
    const libs = this.libsFor(base);
    let evidence: EvidenceReport = { ...base.evidence, candidate: { sha256: sha256(source), producer: "evolution", kind: "evolved" }, checkedAt: new Date().toISOString(), assessment: `Evolved from version ${base.version} (${record.objective}): passed the retained conformance suite.` };
    if (run) {
      const analysis = await this.analyse(run.goal, run.base);
      const gap = analysis.gaps.find((g) => g.id === contract.gap);
      if (gap) {
        const seed = Math.floor(Math.random() * 1e9);
        evidence = await verify({ universe: this.universe, contract, bench: new TestBench({ universe: this.universe, goal: run.goal, gap, contract, base: run.base, seed }), backend: this.backend, source, producer: "evolution", kind: "evolved", seed, libs });
        if (evidence.level !== "verified-in-domain") throw new Refused("evolution-regression", `re-verification reached only ${evidence.level}`);
      }
    }
    const next: CapabilityManifest = {
      ...base, version: this.vault.nextVersion(base.id), artefact: { ...base.artefact, sha256: this.vault.put(source), bytes: Buffer.byteLength(source) }, evidence, receipts: [],
      provenance: { ...base.provenance, parent: { id: base.id, version: base.version }, objective: record.objective, createdAt: new Date().toISOString(), producer: "evolution" },
      limitations: evidence.limitations,
    };
    this.vault.retain(next);
    this.activate(this.vault.manifest(next.id)!);
    void measured;
    return next;
  }

  /** After an incompatible change, try to construct a new version that satisfies today's programs. */
  async repair(id: string, opts: { wait?: boolean; strategy?: Strategy } = {}): Promise<RunRecord> {
    const clean = id.replace(/@\d+$/, "");
    const m = this.vault.manifest(clean);
    if (!m) throw new Refused("unknown-capability", `no retained capability ${clean}`);
    const origin = this.runs(500).find((r) => r.id === m.provenance.run);
    if (!origin) throw new Refused("no-origin", `the run that created ${clean} is not on this host, so its goal cannot be restated`);
    return this.startInvention(origin.goal, origin.base, { wait: opts.wait, strategy: opts.strategy });
  }

  // ---------------------------------------------------------- knowledge

  explain(id: string, detail: "summary" | "full" = "summary") {
    const clean = id.replace(/@\d+$/, "");
    const m = this.vault.manifest(clean);
    if (m) {
      const state = this.vault.state(clean)!;
      const summary = {
        id: m.id, version: m.version, status: m.status, level: m.evidence.level, purpose: m.purpose, title: m.title,
        how: "exapt_use with input as a string (encoding base64 for bytes)",
        input: m.inputs[0], output: m.outputs[0], domain: m.evidence.domain, oracles: m.evidence.oracles, tiers: m.evidence.tiers, mutation: m.evidence.mutation,
        assessment: m.evidence.assessment, limitations: m.limitations, dependencies: m.dependencies.map((d) => (d.kind === "program" ? { program: d.name, role: d.role, sha256: d.sha256.slice(0, 12) } : { capability: d.id, version: d.version })),
        provenance: m.provenance, permissions: m.permissions, sourceBytes: m.artefact.bytes, sourceSha256: m.artefact.sha256, rejectedAttempts: m.rejected.length, versions: state.versions, pinned: state.pinned ?? null,
      };
      if (detail === "summary") return summary;
      return { ...summary, source: this.vault.source(m), contract: { ...m.contract, source: { ...m.contract.source, sample: m.contract.source.sample.slice(0, 2000) } }, counterexamples: m.counterexamples, rejected: m.rejected, history: state.history, execution: m.evidence.execution };
    }
    const node = this.universe.nodes().find((n) => n.id === id);
    if (!node) throw new Refused("unknown-capability", `nothing is known as ${id}`);
    const t = this.universe.tools.get(id);
    return { ...node, contract: t?.contract.input ? { requiredFields: t.contract.input.requiredFields, influentialFields: t.contract.input.influentialFields, claims: t.contract.claims, accepts: reprLabel(t.contract.input.repr), produces: t.contract.output ? reprLabel(t.contract.output.repr) : null } : null };
  }

  memory(opts: { query?: string; kind?: "capabilities" | "failures" | "versions" | "workflows"; id?: string; limit?: number } = {}) {
    const q = (opts.query ?? "").toLowerCase();
    if (opts.kind === "failures") return { failures: this.vault.rejected(opts.limit ?? 20).filter((r) => !q || JSON.stringify(r).toLowerCase().includes(q)) };
    if (opts.kind === "workflows") return { workflows: this.workflows() };
    if (opts.kind === "versions") {
      if (!opts.id) throw new Refused("missing-id", "versions needs a capability id");
      const s = this.vault.state(opts.id);
      if (!s) throw new Refused("unknown-capability", `no retained capability ${opts.id}`);
      return { versions: s.versions, current: s.current, pinned: s.pinned ?? null, history: s.history };
    }
    const out = this.vault.list().flatMap((s) => {
      const m = this.vault.manifest(s.id);
      if (!m) return [];
      if (q && !`${m.id} ${m.purpose} ${m.title}`.toLowerCase().includes(q)) return [];
      return [{ id: m.id, version: m.version, status: m.status, level: m.evidence.level, purpose: m.purpose.slice(0, 120), input: m.inputs[0].representation, output: m.outputs[0].representation, producer: m.provenance.producer }];
    });
    return { capabilities: out.slice(0, opts.limit ?? 20), total: out.length };
  }

  evolution(id?: string): EvolutionAttempt[] {
    return evolutionHistory(this.config.home, id);
  }

  exportCapability(id: string): CapabilityBundle {
    return this.vault.exportBundle(id.replace(/@\d+$/, ""));
  }

  async importCapability(bundle: CapabilityBundle): Promise<{ manifest: CapabilityManifest; revalidation: RevalidationResult }> {
    const manifest = this.vault.importBundle(bundle);
    const revalidation = await this.revalidate(manifest.id);
    return { manifest: this.vault.manifest(manifest.id)!, revalidation };
  }

  // ---------------------------------------------------------- health

  async doctor(opts: { attack?: boolean } = {}): Promise<Doctor> {
    const checks: Doctor["checks"] = [];
    const major = Number(process.versions.node.split(".")[0]);
    const minor = Number(process.versions.node.split(".")[1]);
    const nodeOk = major > 22 || (major === 22 && minor >= 18);
    checks.push({ name: "node", status: nodeOk ? "ok" : "fail", detail: process.version, ...(nodeOk ? {} : { next: "Install Node 22.18 or later." }) });
    const vendored = readJson<{ commit: string; files: Record<string, string> }>(path.join(import.meta.dirname, "../../vendor/rightclick-x/UPSTREAM.json"));
    if (vendored) {
      const root = path.join(import.meta.dirname, "../../vendor/rightclick-x");
      const drift = Object.entries(vendored.files).filter(([f, h]) => !fs.existsSync(path.join(root, f)) || sha256(fs.readFileSync(path.join(root, f))) !== h);
      checks.push({ name: "rightclick-x", status: drift.length ? "fail" : "ok", detail: drift.length ? `${drift.length} vendored file(s) differ from upstream ${vendored.commit.slice(0, 7)}` : `upstream ${vendored.commit.slice(0, 7)}, ${Object.keys(vendored.files).length} files byte-identical` });
    }
    checks.push({ name: "program sandbox", status: this.host.sandbox ? "ok" : "warn", detail: this.host.sandbox ? `${this.host.sandbox.kind}; memory and process limits are sampled, not kernel-enforced, for environment programs` : "none on this platform: environment programs will not run", ...(this.host.sandbox ? {} : { next: "Linux needs bubblewrap; Windows is unsupported." }) });
    const d = dockerStatus();
    checks.push({ name: "generated-code boundary", status: d.available && d.imagePresent ? "ok" : "fail", detail: d.available ? `Docker ${d.serverVersion}: ${d.detail}` : d.detail, ...(d.available && d.imagePresent ? {} : { next: d.available ? "Run `npm run setup`." : "Install and start Docker. Until then EXAPT refuses to run generated code." }) });
    let report: SelfTestReport | undefined;
    if (opts.attack !== false && d.available && d.imagePresent) {
      report = await selfTest(new DockerBackend());
      checks.push({ name: "containment self-test", status: report.ok ? "ok" : "fail", detail: report.ok ? `${report.checks.length} attacks contained` : report.failures.join("; ") });
    }
    if (this.config.model) checks.push({ name: "model", status: "ok", detail: `${this.config.model.provider}/${this.config.model.model}; at most ${this.config.budget.maxCalls} calls, ${this.config.budget.maxTokens} tokens, $${this.config.budget.maxCostUsd} per run` });
    else checks.push({ name: "model", status: "warn", detail: "none configured: only deterministic synthesis is available, and it is reported as such", next: "Set EXAPT_MODEL (ollama, openai-compatible, claude-cli or codex-cli) to enable model synthesis." });
    checks.push({ name: "programs", status: this.config.programs.length ? "ok" : "warn", detail: this.config.programs.length ? this.config.programs.join(", ") : "no programs are authorised", ...(this.config.programs.length ? {} : { next: "List program paths or directories in exapt.config.json or EXAPT_PROGRAMS." }) });
    const orphans = d.available ? reapOrphans() : 0;
    if (orphans) checks.push({ name: "cleanup", status: "warn", detail: `removed ${orphans} orphaned sandbox container(s)` });
    return { ok: !checks.some((c) => c.status === "fail"), checks, ...(report ? { selfTest: report } : {}) };
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export { ProgramChanged };
export type { Objective };
