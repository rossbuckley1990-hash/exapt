// The behavioural contract, and the test bench derived from it. The contract is built by EXAPT from
// the goal and from evidence in the environment; the model that proposes programs has no part in it
// and never sees most of it. Tests come in tiers with different visibility:
//
//   visible      shown to the synthesiser
//   independent  drawn fresh each round; failures become counterexamples for the next attempt
//   boundary     valid extremes
//   malformed    invalid input a correct program must refuse
//   holdout      drawn fresh for each candidate that reaches this gate; failures are never fed
//                back, so no later attempt can have been fitted to them
import { accepted, cellText, isRecordRepr, parseRecords, renderRecords, reprLabel, sniff, type Goal, type Repr, type Universe } from "../capability-universe/index.ts";
import { digest, Rng, pool } from "../shared/index.ts";
import { loadSample, type Gap, type OracleSpec } from "../gap-reasoner/index.ts";
import { boundaryInputs, generateLike, malformedBinary, malformedInputs } from "./generators.ts";
import type { SynthesisSpec } from "../synthesiser/index.ts";

export type Tier = "visible" | "independent" | "boundary" | "malformed" | "holdout";

export interface TestCase {
  id: string;
  tier: Tier;
  /** Text, or base64 when `binary`. */
  input: string;
  binary?: boolean;
  /** The target bytes, when an independent source states them. */
  expected?: string;
  origin: "inverse-pair" | "corpus" | "stated-example" | "upstream" | "generated" | "boundary" | "malformed";
  note?: string;
  /** Text a correct output must still contain. */
  mark?: string;
  /** Oracles that failed qualification for this case and do not judge it. */
  disqualified?: string[];
}

export interface BehaviouralContract {
  id: string;
  title: string;
  gap: string;
  goal: string;
  inputKind: "text" | "binary";
  source: { label: string; repr: Repr; sample: string };
  target: { label: string; repr: Repr; sample: string; requiredFields: string[] };
  consumer: string | null;
  upstream: string[];
  downstream: string[];
  oracles: OracleSpec[];
  /** Numeric slack per source field when comparing through an inverse route, measured not assumed. */
  tolerance: Record<string, number>;
  properties: string[];
}

export interface BenchSizes {
  visible: number;
  independent: number;
  holdout: number;
}

export const DEFAULT_SIZES: BenchSizes = { visible: 3, independent: 12, holdout: 12 };

/** Measure how far a one-unit change in each target value moves the source through the inverse. */
async function calibrate(universe: Universe, route: string[], sample: string, repr: Repr, sourceRepr: Repr): Promise<Record<string, number>> {
  const tolerance: Record<string, number> = {};
  const through = async (text: string) => {
    let cur = text;
    for (const id of route) {
      const r = await universe.tool(id)!.run(cur);
      if (!accepted(r)) return null;
      cur = r.stdout;
    }
    return parseRecords(cur, sourceRepr.syntax);
  };
  const base = await through(sample);
  if (!base?.length) return tolerance;
  for (const f of repr.fields.filter((x) => x.kind === "decimal" || x.kind === "int")) {
    const places = f.decimals ?? 0;
    const rows = parseRecords(sample, repr.syntax);
    const bumped = rows.map((r) => ({ ...r, [f.name]: typeof r[f.name] === "number" ? Number((Number(r[f.name]) + 10 ** -places).toFixed(places)) : (Number(r[f.name]) + 10 ** -places).toFixed(places) }));
    const moved = await through(renderRecords(bumped, repr.syntax, repr.fields.map((x) => x.name)));
    if (!moved) continue;
    for (const key of Object.keys(base[0])) {
      const diff = Math.abs(Number(moved[0][key]) - Number(base[0][key]));
      // A target value is rounded to within half a unit; that is all the slack a correct program needs.
      if (Number.isFinite(diff) && diff > 0) tolerance[key] = Math.max(tolerance[key] ?? 0, diff * 0.51);
    }
  }
  return tolerance;
}

export async function buildContract(universe: Universe, gap: Gap, goal: Goal): Promise<BehaviouralContract> {
  const binary = gap.from.repr.syntax.format === "binary";
  const inverse = gap.oracles.find((o) => o.kind === "inverse-route");
  const tolerance = inverse && inverse.kind === "inverse-route" && gap.to.sample ? await calibrate(universe, inverse.route, gap.to.sample, gap.to.repr, gap.from.repr) : {};
  const properties = [
    "Pure and deterministic: the same input always gives the same output.",
    ...(isRecordRepr(gap.to.repr) && isRecordRepr(gap.from.repr) ? ["One output record per input record, in input order."] : []),
    ...(gap.to.consumer ? [`Every output is accepted by ${universe.tool(gap.to.consumer)?.name ?? gap.to.consumer}.`] : []),
  ];
  return {
    id: `contract-${digest([gap.id, goal.id]).slice(0, 12)}`,
    title: goal.intent,
    gap: gap.id,
    goal: goal.id,
    inputKind: binary ? "binary" : "text",
    source: { label: gap.from.label, repr: gap.from.repr, sample: binary ? gap.from.bytes.toString("base64") : gap.from.bytes.toString("utf8") },
    target: { label: gap.to.label, repr: gap.to.repr, sample: gap.to.sample ?? "", requiredFields: gap.to.requiredFields },
    consumer: gap.to.consumer,
    upstream: gap.from.lineage.map((l) => l.tool),
    downstream: gap.to.downstream,
    oracles: gap.oracles,
    tolerance,
    properties,
  };
}

/** What a synthesiser is told. Oracles, tolerances and held-out data are not part of it. */
export function specFor(universe: Universe, contract: BehaviouralContract, intent: string): SynthesisSpec {
  const docs: SynthesisSpec["documentation"] = [];
  const add = (id: string, role: string) => {
    const t = universe.tool(id);
    if (t?.contract.docs) docs.push({ program: t.name, role, text: t.contract.docs });
  };
  for (const id of contract.upstream) add(id, "writes the source format");
  if (contract.consumer) add(contract.consumer, "must accept your output");
  for (const o of contract.oracles) if (o.kind === "inverse-route") for (const id of o.route) add(id, "reads the target format and writes the source format");
  const sample = contract.inputKind === "binary" ? "(binary; see the examples)" : contract.source.sample.split("\n").slice(0, 30).join("\n");
  return {
    task: `${intent}. Implement the single missing transformation from ${contract.source.label} to ${contract.target.label}.`,
    inputKind: contract.inputKind,
    source: { label: contract.source.label, sample },
    target: { label: contract.target.label, sample: contract.target.sample, requiredFields: contract.target.requiredFields },
    documentation: docs,
    properties: contract.properties,
  };
}

export class TestBench {
  private readonly universe: Universe;
  private readonly goal: Goal;
  private readonly gap: Gap;
  readonly contract: BehaviouralContract;
  private readonly base: string;
  private readonly seed: number;
  readonly sizes: BenchSizes;
  /** What this bench could not test, found while building it. */
  readonly limitations = new Set<string>();
  private cases = 0;
  private readonly corpusTiers: { visible: number[]; independent: number[]; holdout: number[] };
  private readonly exampleTiers: { visible: number[]; holdout: number[] };

  constructor(o: { universe: Universe; goal: Goal; gap: Gap; contract: BehaviouralContract; base: string; seed: number; sizes?: Partial<BenchSizes> }) {
    this.universe = o.universe;
    this.goal = o.goal;
    this.gap = o.gap;
    this.contract = o.contract;
    this.base = o.base;
    this.seed = o.seed;
    this.sizes = { ...DEFAULT_SIZES, ...o.sizes };
    // Fixed partition: which file is held out never depends on what any candidate did.
    const rng = new Rng(o.seed ^ 0x51ed);
    const corpus = rng.shuffle((o.goal.corpus ?? []).map((_, i) => i));
    const nVisible = Math.max(1, Math.round(corpus.length * 0.3));
    const nHold = Math.max(1, Math.round(corpus.length * 0.4));
    this.corpusTiers = { visible: corpus.slice(0, nVisible), holdout: corpus.slice(nVisible, nVisible + nHold), independent: corpus.slice(nVisible + nHold) };
    const examples = rng.shuffle((o.goal.want.examples ?? []).map((_, i) => i));
    const held = Math.floor(examples.length / 2);
    this.exampleTiers = { holdout: examples.slice(0, held), visible: examples.slice(held) };
  }

  private next(tier: Tier): string {
    return `${tier}-${++this.cases}`;
  }

  private get inverseRoute(): string[] | undefined {
    const o = this.contract.oracles.find((x) => x.kind === "inverse-route");
    return o?.kind === "inverse-route" ? o.route : undefined;
  }

  private async through(route: string[], text: string): Promise<string | null> {
    let cur = text;
    for (const id of route) {
      const r = await this.universe.tool(id)!.run(cur).catch(() => null);
      if (!r || !accepted(r)) return null;
      cur = r.stdout;
    }
    return cur;
  }

  /** A pair with a known answer: generate the target side, then run the inverse program. */
  private async inversePairs(tier: Tier, n: number, rng: Rng, rows: () => number): Promise<TestCase[]> {
    const route = this.inverseRoute;
    const { sample, repr } = this.contract.target;
    if (!route || !sample) return [];
    const drafts = Array.from({ length: n * 2 }, () => generateLike(sample, repr, rng, rows()));
    const consumer = this.contract.consumer ? this.universe.tool(this.contract.consumer) : undefined;
    const built = await pool(drafts, 6, async (target) => {
      if (consumer && !accepted(await consumer.run(target).catch(() => ({ ok: false, stdout: "", stderr: "" })))) return null;
      const input = await this.through(route, target);
      return input === null ? null : { input, expected: target };
    });
    return built.filter((x): x is { input: string; expected: string } => !!x).slice(0, n)
      .map((p) => ({ id: this.next(tier), tier, input: p.input, expected: p.expected, origin: "inverse-pair" as const }));
  }

  /** Fresh source values produced by the real upstream programs, or generated directly. */
  private async upstreamInputs(tier: Tier, n: number, rng: Rng, rows: () => number): Promise<TestCase[]> {
    const lineage = this.contract.upstream;
    const seeds = this.goal.have?.samples?.map((s) => loadSample(s, this.base).toString("utf8")) ?? [];
    if (this.contract.inputKind === "binary" || !isRecordRepr(this.contract.source.repr)) return [];
    if (!lineage.length) {
      return Array.from({ length: n }, () => ({ id: this.next(tier), tier, input: generateLike(this.contract.source.sample, this.contract.source.repr, rng, rows()), origin: "generated" as const }));
    }
    if (!seeds.length) return [];
    const seedRepr = sniff(seeds[0]);
    const drafts = Array.from({ length: n * 2 }, () => generateLike(seeds[0], seedRepr, rng, rows()));
    const built = await pool(drafts, 6, (d) => this.through(lineage, d));
    return built.filter((x): x is string => x !== null && x.trim() !== "").slice(0, n).map((input) => ({ id: this.next(tier), tier, input, origin: "upstream" as const }));
  }

  private corpusCases(tier: Tier, indexes: number[]): TestCase[] {
    return indexes.map((i) => {
      const c = this.goal.corpus![i];
      const input = loadSample(c.input, this.base);
      const binary = this.contract.inputKind === "binary";
      return { id: this.next(tier), tier, input: binary ? input.toString("base64") : input.toString("utf8"), ...(binary ? { binary } : {}), expected: loadSample(c.truth, this.base).toString("utf8"), origin: "corpus" as const, note: c.name };
    });
  }

  private exampleCases(tier: Tier, indexes: number[]): TestCase[] {
    return indexes.map((i) => {
      const e = this.goal.want.examples![i];
      const input = loadSample(e.input, this.base);
      const binary = this.contract.inputKind === "binary";
      return { id: this.next(tier), tier, input: binary ? input.toString("base64") : input.toString("utf8"), ...(binary ? { binary } : {}), expected: loadSample(e.output, this.base).toString("utf8"), origin: "stated-example" as const };
    });
  }

  async visible(): Promise<TestCase[]> {
    const rng = new Rng(this.seed + 1);
    return [
      ...this.corpusCases("visible", this.corpusTiers.visible),
      ...this.exampleCases("visible", this.exampleTiers.visible),
      ...await this.inversePairs("visible", this.sizes.visible, rng, () => rng.int(3, 6)),
    ];
  }

  async independent(round: number): Promise<TestCase[]> {
    const rng = new Rng(this.seed * 31 + 1000 * round + 7);
    const half = Math.ceil(this.sizes.independent / 2);
    const cases = [
      ...this.corpusCases("independent", this.corpusTiers.independent),
      ...await this.inversePairs("independent", half, rng, () => rng.int(2, 30)),
      ...await this.upstreamInputs("independent", half, rng, () => rng.int(2, 30)),
    ];
    return cases;
  }

  /** Can the inverse route itself carry this text? An oracle that cannot is not evidence about it:
   *  a correct program would fail through no fault of its own. */
  private async inverseCarries(mark: string): Promise<boolean> {
    const route = this.inverseRoute;
    const { sample, repr } = this.contract.target;
    if (!route || !sample) return false;
    const text = repr.fields.find((f) => f.kind === "string");
    if (!text) return false;
    const rows = parseRecords(sample, repr.syntax).map((r) => ({ ...r, [text.name]: `${cellText(r[text.name])}${mark}` }));
    const back = await this.through(route, renderRecords(rows, repr.syntax, repr.fields.map((f) => f.name)));
    if (back === null) return false;
    try {
      return parseRecords(back, this.contract.source.repr.syntax).some((r) => Object.values(r).some((v) => cellText(v).includes(mark)));
    } catch {
      return false;
    }
  }

  async boundary(): Promise<TestCase[]> {
    if (this.contract.inputKind === "binary") return [];
    const rng = new Rng(this.seed + 41);
    const sample = this.contract.source.sample;
    const out: TestCase[] = [];
    for (const b of boundaryInputs(sample, this.contract.source.repr, rng)) {
      const unqualified = b.mark !== undefined && this.inverseRoute !== undefined && !(await this.inverseCarries(b.mark));
      if (unqualified) this.limitations.add(`The inverse route cannot carry "${b.name}", so that case is judged by the consumer and by text preservation only.`);
      out.push({ id: this.next("boundary"), tier: "boundary", input: b.input, origin: "boundary", note: b.name, ...(b.mark !== undefined ? { mark: b.mark } : {}), ...(unqualified ? { disqualified: ["inverse-route"] } : {}) });
    }
    return out;
  }

  malformed(): TestCase[] {
    const rng = new Rng(this.seed + 43);
    if (this.contract.inputKind === "binary") {
      const file = Buffer.from(this.contract.source.sample, "base64");
      return malformedBinary(file, rng).map((b) => ({ id: this.next("malformed"), tier: "malformed", input: b.input.toString("base64"), binary: true, origin: "malformed", note: b.name }));
    }
    return malformedInputs(this.contract.source.sample, this.contract.source.repr, rng).map((b) => ({ id: this.next("malformed"), tier: "malformed", input: b.input, origin: "malformed", note: b.name }));
  }

  /** A fresh draw for each use. A finite corpus cannot be redrawn, so its uses are counted instead. */
  async holdout(draw: number): Promise<TestCase[]> {
    const rng = new Rng(this.seed * 131 + 977 * draw + 19);
    const half = Math.ceil(this.sizes.holdout / 2);
    return [
      ...this.corpusCases("holdout", this.corpusTiers.holdout),
      ...this.exampleCases("holdout", this.exampleTiers.holdout),
      ...await this.inversePairs("holdout", half, rng, () => rng.int(2, 60)),
      ...await this.upstreamInputs("holdout", half, rng, () => rng.int(2, 60)),
    ];
  }

  describeDomain(cases: TestCase[]): string[] {
    const rows = cases.filter((c) => !c.binary).map((c) => (isRecordRepr(this.contract.source.repr) ? parseRecordsSafe(c.input, this.contract.source.repr) : 0));
    const out = [`source: ${reprLabel(this.contract.source.repr)}`];
    if (rows.length) out.push(`tested from ${Math.min(...rows)} to ${Math.max(...rows)} records per input`);
    return out;
  }
}

function parseRecordsSafe(input: string, repr: Repr): number {
  try {
    return parseRecords(input, repr.syntax).length;
  } catch {
    return 0;
  }
}
