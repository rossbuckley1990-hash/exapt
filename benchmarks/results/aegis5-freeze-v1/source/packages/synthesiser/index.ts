// Engine C: the capability synthesiser. A portfolio that proposes candidate programs. Which member
// proposed a candidate is recorded and reported; acceptance never depends on it. Every candidate,
// from any member, is untrusted and must survive the same experiments.
import type { Budget, ModelAdapter } from "../model-adapters/index.ts";
import { newId, sha256 } from "../shared/index.ts";
import { describeLens, emitLens, synthesiseLens } from "./lens.ts";
import { induceLayout } from "./layout.ts";
import { proposeWithModel, type ModelRequest, type Pair } from "./model.ts";

export * from "./model.ts";
export { emitLens, synthesiseLens } from "./lens.ts";

export type SynthesiserKind = "enumerative" | "layout-induction" | "model" | "deletion-search" | "injected-control" | "test-double";

export interface Candidate {
  id: string;
  source: string;
  sha256: string;
  kind: SynthesiserKind;
  round: number;
  /** What produced this, plainly: never a model name unless a model produced it. */
  producer: string;
  explanation: string[];
  explored?: number;
}

export type Strategy = "auto" | "model-first" | "model-only" | "deterministic-only";

export interface ProposeContext extends Omit<ModelRequest, "pairs"> {
  pairs: Pair[];
  /** Everything the model may see; the deterministic search starts from less, on purpose. */
  allPairs?: Pair[];
  round: number;
  wanted: number;
  tried: Set<string>;
  strategy: Strategy;
  model: ModelAdapter | null;
  budget: Budget;
  onModelCall?: (entry: Record<string, unknown>) => void;
}

export interface Proposal {
  candidates: Candidate[];
  /** Why a member produced nothing, reported rather than hidden. */
  notes: string[];
}

export const makeCandidate = (source: string, kind: SynthesiserKind, round: number, producer: string, explanation: string[] = [], explored?: number): Candidate => ({
  id: newId("cand"), source, sha256: sha256(source), kind, round, producer, explanation, ...(explored !== undefined ? { explored } : {}),
});

function deterministic(ctx: ProposeContext, notes: string[]): Candidate[] {
  const out: Candidate[] = [];
  const pairs = ctx.pairs;
  if (!pairs.length) {
    notes.push("deterministic synthesis needs value pairs; none are available for this gap");
    return out;
  }
  if (pairs[0].binary) {
    const r = induceLayout(pairs);
    if (!r.ok) notes.push(`layout induction: ${r.reason}`);
    else for (const p of r.programs) if (!ctx.tried.has(sha256(p.source))) out.push(makeCandidate(p.source, "layout-induction", ctx.round, "binary layout induction", p.explanation, r.explored));
    return out;
  }
  const r = synthesiseLens(pairs.map((p) => ({ input: p.input, output: p.output })), { alternatives: Math.max(ctx.wanted, 3) });
  if (!r.ok) {
    notes.push(`enumerative search: ${r.reason} (${r.explored} expressions explored)`);
    return out;
  }
  for (const program of r.programs) {
    const source = emitLens(program);
    if (!ctx.tried.has(sha256(source))) out.push(makeCandidate(source, "enumerative", ctx.round, "enumerative lens search", describeLens(program), r.explored));
  }
  return out.slice(0, ctx.wanted);
}

async function fromModel(ctx: ProposeContext, notes: string[], count: number): Promise<Candidate[]> {
  const out: Candidate[] = [];
  if (!ctx.model) {
    notes.push("no model is configured");
    return out;
  }
  for (let attempt = 0; attempt < count; attempt++) {
    const r = await proposeWithModel(ctx.model, ctx.budget, { ...ctx, pairs: ctx.allPairs ?? ctx.pairs }, { attempt: ctx.round + attempt, onUsage: ctx.onModelCall });
    if (r.error) notes.push(`model: ${r.error}`);
    if (r.source && !ctx.tried.has(sha256(r.source))) {
      out.push(makeCandidate(r.source, r.real ? "model" : "test-double", ctx.round, `${r.provider}/${r.model}`));
    }
  }
  return out;
}

export async function propose(ctx: ProposeContext): Promise<Proposal> {
  const notes: string[] = [];
  const candidates: Candidate[] = [];
  const modelFirst = ctx.strategy === "model-first" || ctx.strategy === "model-only";
  if (ctx.strategy !== "model-only" && !modelFirst) candidates.push(...deterministic(ctx, notes));
  if (ctx.strategy !== "deterministic-only" && (modelFirst || candidates.length < ctx.wanted)) candidates.push(...await fromModel(ctx, notes, modelFirst ? ctx.wanted : Math.max(1, ctx.wanted - candidates.length)));
  if (ctx.strategy === "model-first" && !candidates.length) candidates.push(...deterministic(ctx, notes));
  return { candidates, notes };
}
