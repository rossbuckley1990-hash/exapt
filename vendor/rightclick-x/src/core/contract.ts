// Outcome contracts: what a compose request asks for, made explicit and machine-checkable, and the
// test of whether a plan (before running) and a result (after running) honour it.
//
// A completed chain of operations is not a correct outcome. The historical failure (mandoc -> od):
// "octal dump of the bytes of a text" ran a manual-page formatter first and dumped ITS output, so
// the bytes no longer were the caller's. The contract's lineage invariant makes that a violation:
// every step must be justified by the request, as one of
//   requested            - it performs a transformation the request names (intent words);
//   required-information - its result carries information the caller requires;
//   type-conversion      - it turns a value into a different type that a later step (or the
//                          answer) needs, which the caller's value could not supply directly;
//   caller-anchored      - the caller named it (`through`).
// A step that is none of these changes the data on the way for no stated reason: the plan is not
// established, and it does not run. Saved composites are looked into, step by step, against the
// CURRENT request (a pipeline saved for one request is not justified for another).
//
// Contracts state only what can be observed or is backed by evidence; they never claim arbitrary
// semantic correctness. What cannot be established is reported as such.
import type { CapabilityGraph } from "./graph.ts";
import { tokensOf } from "./planner.ts";
import { carries } from "./satisfaction.ts";
import type { Capability, PlanStep, SemType } from "./types.ts";

export type Assurance = "independently-checked" | "predicate-checked" | "unchecked";
export type StepReason = "requested" | "required-information" | "type-conversion" | "caller-anchored" | "unjustified";

export interface OutcomeContract {
  /** INPUT SEMANTICS: what the caller supplied, as typed. */
  input: Array<{ name: string; type: SemType }>;
  /** REQUIRED OUTPUT INFORMATION */
  output: { type: SemType; requires: string[] };
  /** TRANSFORMATION REQUIREMENTS: the request's own words (type words excluded). */
  transformations: string[];
  /** INVARIANTS checked before and after running. */
  invariants: string[];
  /** COMPLETENESS REQUIREMENTS */
  completeness: string;
  /** PROVENANCE REQUIREMENTS */
  provenance: string;
  /** VERIFICATION CONDITIONS */
  verification: { predicates: number; witnesses: number; strongest: Assurance };
  /** AUTHORITY AND RISK */
  authority: { risks: string[]; destructiveNeedsOperatorApproval: boolean };
  /** ALLOWED UNCERTAINTY */
  allowedUncertainty: string;
  /** FAILURE CONDITIONS */
  failureConditions: string[];
}

export interface StepJustification {
  step: number;
  capability: string;
  title: string;
  reason: StepReason;
  /** For a saved composite: its inner steps, judged against this request. */
  inner?: StepJustification[];
}

export interface ContractAssessment {
  status: "satisfied" | "violated";
  steps: StepJustification[];
  violations: string[];
  /** Every step (inner steps included) has evidence of keeping every word of its input. */
  preservesInput: boolean;
}

const GENERIC = /^(text|json|number|boolean|id|list:text|list:json)$/;

export function contractFor(opts: {
  have: Record<string, SemType>;
  want: SemType;
  intent: Set<string>;
  require: string[];
  predicates: number;
  witnesses: number;
  risks?: string[];
}): OutcomeContract {
  return {
    input: Object.entries(opts.have).map(([name, type]) => ({ name, type })),
    output: { type: opts.want, requires: opts.require },
    transformations: [...opts.intent],
    invariants: [
      "lineage: every step is requested, provides required information, converts a type a later step needs, or was named by the caller",
      "distinct inputs: no step receives the same value on two required ports",
      "preservation: where every step has evidence of keeping its input's words, the result must keep the caller's words",
    ],
    completeness: opts.require.length ? `the result carries: ${opts.require.join(", ")}` : `the result is of type ${opts.want}`,
    provenance: "every bound value comes from the caller or an earlier step of this plan",
    verification: { predicates: opts.predicates, witnesses: opts.witnesses, strongest: opts.witnesses ? "independently-checked" : opts.predicates ? "predicate-checked" : "unchecked" },
    authority: { risks: opts.risks ?? [], destructiveNeedsOperatorApproval: true },
    allowedUncertainty: "none: a result whose contract cannot be established is reported as not established, not as success",
    failureConditions: [
      "a step not justified by the request (lineage)",
      "a required piece of information missing from the result",
      "a join supported only by a generic type when information is required",
      "a check (predicate or witness) refuted",
      "content lost where every step was expected to preserve it",
    ],
  };
}

function typeOfRef(graph: CapabilityGraph, steps: PlanStep[], ref: string, have: Record<string, SemType>): SemType | undefined {
  if (ref.startsWith("$in.")) return have[ref.slice(4).split(".")[0]];
  const [si, ...pp] = ref.split(".");
  const cap = graph.get(steps[Number(si)]?.capability ?? "");
  return cap?.outputs.find((o) => o.name === pp.join("."))?.type ?? cap?.outputs[0]?.type;
}

function judge(graph: CapabilityGraph, steps: PlanStep[], result: string, ctx: { intent: Set<string>; require: string[]; have: Record<string, SemType>; want: SemType; anchors: Set<string> }): StepJustification[] {
  return steps.map((st, i) => {
    const cap = graph.get(st.capability);
    const base = { step: i, capability: st.capability, title: cap?.title ?? st.capability };
    if (!cap) return { ...base, reason: "unjustified" as StepReason };
    if (ctx.anchors.has(cap.id)) return { ...base, reason: "caller-anchored" as StepReason };
    if (cap.invoke.kind === "composite") {
      // Judge the saved pipeline's own steps against this request.
      const innerSteps = cap.invoke.steps;
      const innerHave: Record<string, SemType> = Object.fromEntries(cap.inputs.map((p) => [p.name, p.type]));
      const inner = judge(graph, innerSteps, cap.invoke.result ?? `${innerSteps.length - 1}.`, { ...ctx, have: innerHave, anchors: new Set() });
      const ok = inner.every((x) => x.reason !== "unjustified");
      return { ...base, reason: (ok ? (inner.some((x) => x.reason === "requested") ? "requested" : "type-conversion") : "unjustified") as StepReason, inner };
    }
    if ([...tokensOf(cap)].some((t) => ctx.intent.has(t))) return { ...base, reason: "requested" as StepReason };
    if (ctx.require.length && ctx.require.some((t) => [...cap.outputs.map((o) => o.name), ...(cap.fields ?? []).map((f) => f.path)].some((p) => carries(p, t)))) return { ...base, reason: "required-information" as StepReason };
    // A type conversion: what it consumed is of another type than what it produces for later use.
    const consumed = st.bindings.filter((b) => b.value === undefined).map((b) => typeOfRef(graph, steps, b.from, ctx.have)).filter(Boolean) as SemType[];
    const usedLater = steps.slice(i + 1).some((s) => s.bindings.some((b) => b.from.startsWith(`${i}.`))) || result.startsWith(`${i}.`);
    const produced = cap.outputs.map((o) => o.type);
    const converts = usedLater && produced.some((t) => !consumed.length || consumed.every((c) => c.replace(/^list:/, "") !== t.replace(/^list:/, "")));
    // Same-type plumbing (text -> text, json -> json) is not a conversion anything needed.
    const sameGeneric = consumed.length > 0 && produced.every((t) => GENERIC.test(t)) && consumed.every((c) => produced.includes(c));
    if (converts && !sameGeneric) return { ...base, reason: "type-conversion" as StepReason };
    return { ...base, reason: "unjustified" as StepReason };
  });
}

const preserving = (graph: CapabilityGraph, c: Capability | undefined): boolean => {
  if (!c) return false;
  if (c.invoke.kind === "composite") return c.invoke.steps.every((s) => preserving(graph, graph.get(s.capability)));
  return c.tags.includes("preserves-input-words");
};

export function assessPlan(graph: CapabilityGraph, steps: PlanStep[], result: string, ctx: { intent: Set<string>; require: string[]; have: Record<string, SemType>; want: SemType; anchors: Set<string> }): ContractAssessment {
  const judged = judge(graph, steps, result, ctx);
  const violations: string[] = [];
  const walk = (js: StepJustification[], prefix: string) => {
    for (const j of js) {
      if (j.inner) walk(j.inner, `${prefix}${j.title} › `);
      else if (j.reason === "unjustified") violations.push(`lineage: "${prefix}${j.title}" is not justified by the request (it performs no requested transformation, provides no required information, and converts no type a later step needs)`);
    }
  };
  walk(judged, "");
  for (const st of steps) {
    const froms = st.bindings.filter((b) => b.value === undefined && !b.each).map((b) => JSON.stringify([b.from, b.link?.pointer]));
    if (new Set(froms).size !== froms.length) violations.push(`distinct inputs: ${st.capability} receives the same value on two ports`);
  }
  return { status: violations.length ? "violated" : "satisfied", steps: judged, violations, preservesInput: steps.length > 0 && steps.every((s) => preserving(graph, graph.get(s.capability))) };
}

const words = (v: unknown) => new Set((typeof v === "string" ? v : JSON.stringify(v ?? "")).replace(/<[^>]*>/g, " ").toLowerCase().match(/[a-z0-9]{3,}/g) ?? []);

/** After a run: the caller's words that a preserving plan lost. */
export function lostWords(inputs: unknown[], output: unknown): string[] {
  const got = words(output);
  return [...new Set(inputs.flatMap((v) => [...words(v)]))].filter((w) => !got.has(w));
}
