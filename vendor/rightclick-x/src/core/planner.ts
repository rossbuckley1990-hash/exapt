// The composer: from "what I have" to "what I want" across any providers.
//
// State = the set of typed values available so far (goal inputs plus every
// output produced by earlier steps). A capability is applicable when all of
// its required inputs can be bound to available values; applying it adds its
// outputs. Best-first search over these states, priced by the experience
// ledger, yields ranked multi-provider pipelines. Nobody wrote the glue: the
// types did.

import { assess, carries, STATUS_RANK, type Satisfaction } from "./satisfaction.ts";
import { schemeFits, schemeOnly } from "./identities.ts";
import { validLinkGroup } from "./links.ts";
import { accepts, distance, isNominal } from "./semantics.ts";
import { tokenize, type CapabilityGraph } from "./graph.ts";
import type { Ledger } from "./ledger.ts";
import type { Binding, Capability, PlanStep, Port, Risk, SemType } from "./types.ts";

export interface Goal {
  /** Named inputs the caller can supply, with semantic types. */
  have: Record<string, SemType>;
  /** Desired output type. */
  want: SemType;
  /** Free-text intent ("weather", "translate", "summary") used to rank and filter. */
  intent?: string;
  maxSteps?: number;
  limit?: number;
  /** Capability ids to route around (e.g. ones that just failed). */
  exclude?: Set<string>;
  /** Caller-chosen constraint: only plan with capabilities of these risk labels (e.g. ["read"]). */
  risks?: Risk[];
  /** Anchors: capability ids every returned plan must pass through. The planner wires the rest. */
  through?: string[];
  /** Egress policy: only capabilities whose network traffic stays on these origins (e.g. "https://api.example.com"). */
  origins?: string[];
  /** Required output information (terms such as "resolution"): plans are judged by what their result carries. */
  require?: string[];
  /** Identifier schemes the caller's named inputs were recognised as (see core/identities.ts). */
  schemes?: Record<string, string[]>;
  /** Explicit bindings of an anchored capability port to a named caller input. */
  inputBindings?: Record<string, Record<string, string>>;
}

/**
 * Where a capability sends data, as origins, or "anywhere" when its target comes from its
 * inputs (a URL-taking fetch). Local transforms and platform bindings send nothing out.
 */
export function egressOf(c: Capability, graph: CapabilityGraph, seen = new Set<string>()): string[] | "anywhere" {
  const inv = c.invoke as any;
  const origin = (u: string) => {
    try {
      return [new URL(u).origin];
    } catch {
      return "anywhere" as const;
    }
  };
  switch (inv.kind) {
    case "http":
      return origin(inv.url.replace(/\{[^}]+\}/g, "x"));
    case "graphql":
    case "mcp":
    case "peer":
      return origin(inv.endpoint);
    case "builtin":
      return c.inputs.some((p) => ["url", "image.url", "domain", "ip", "email"].includes(p.type)) ? "anywhere" : [];
    case "platform":
    case "cli": // sandboxed: no network at all
      return [];
    case "composite": {
      if (seen.has(c.id)) return [];
      seen.add(c.id);
      const all = new Set<string>();
      for (const s of inv.steps) {
        const step = graph.get(s.capability);
        const e = step ? egressOf(step, graph, seen) : "anywhere";
        if (e === "anywhere") return e;
        e.forEach((o) => all.add(o));
      }
      return [...all];
    }
    default:
      // Saved goals re-plan on every call; their egress is not fixed in advance.
      return "anywhere";
  }
}

export interface Plan {
  steps: PlanStep[];
  result: string;
  resultType: SemType;
  cost: number;
  intentScore: number;
  /** How well the plan uses the caller's inputs. */
  fit: number;
  /** How content-like the result is (an `extract` beats a `title`). */
  resultScore: number;
  providers: string[];
  summary: string;
  /** With `require`: what the result carries, how each join is supported, and the status. */
  satisfaction?: Satisfaction;
}

interface Value {
  ref: string;
  type: SemType;
  /** Step index that produced it, -1 for goal inputs. */
  step: number;
  /** Identifier schemes the value is known to carry. */
  schemes?: string[];
}

interface BindingValue {
  callerName: string;
  leaf: string;
  intentBonus: number;
}

interface Node {
  values: Value[];
  steps: PlanStep[];
  used: Set<string>;
  cost: number;
}

/** Expansion budget per search depth, so wide graphs (GitHub: 1,200+ ops) still get searched deep. */
const DEPTH_BUDGET = 8000;

/** Items one fan-out step may run over (sequentially); a longer list refuses the step at run time. */
export const FANOUT_MAX = 20;
/** A fan-out step makes up to FANOUT_MAX calls: price it above a single call. */
const FANOUT_COST = 1;
/** A list of these says nothing about what each item is, so it never fans out by type alone. */
const UNSPECIFIC = /^(text|json|number|boolean|id)$/;

export function plan(graph: CapabilityGraph, ledger: Ledger, goal: Goal, expansionBudget = DEPTH_BUDGET): Plan[] {
  // Read-only diagnostics may do less work; never widen the normal search budget.
  const depthBudget = Number.isFinite(expansionBudget) ? Math.max(1, Math.min(DEPTH_BUDGET, Math.floor(expansionBudget))) : DEPTH_BUDGET;
  const maxSteps = Math.min(goal.maxSteps ?? 4, 6);
  const limit = goal.limit ?? 5;
  // Words that only name the requested type ("text" for want: text) are constraints already
  // enforced by want; scoring them as intent rewards steps that merely mention the type.
  const typeWords = new Set(tokenize(goal.want.replace(/^list:/, "").replace(/[.:]/g, " ")));
  const intent = new Set(tokenize(goal.intent ?? "").filter((t) => !typeWords.has(t)));
  const excluded = goal.exclude ?? new Set<string>();
  const anchors = new Set(goal.through ?? []);
  const anchorOrder = new Map((goal.through ?? []).map((id, i) => [id, i]));
  const risks = goal.risks === undefined ? null : new Set(goal.risks);
  const origins = goal.origins === undefined ? null : new Set(goal.origins.map((o) => new URL(o).origin));
  const withinPolicy = (c: Capability) => {
    if (!origins) return true;
    const e = egressOf(c, graph);
    return e !== "anywhere" && e.every((o) => origins.has(o));
  };
  const caps = graph.list().filter(
    (c) =>
      !excluded.has(c.id) &&
      !(c.invoke.kind === "composite" && c.invoke.steps.some((s) => excluded.has(s.capability))) &&
      (!risks || risks.has(c.risk)) &&
      // Investigated behaviour that experiments did not support is never composed automatically.
      !c.tags.includes("unsupported") &&
      // Capabilities whose arguments a caller must choose (documented options, literal operands):
      // only when the caller named them (through).
      (!c.tags.includes("direct-only") || anchors.has(c.id)) &&
      withinPolicy(c),
  );
  const start: Node = {
    values: Object.entries(goal.have).map(([name, type]) => ({ ref: `$in.${name}`, type, step: -1, ...(goal.schemes?.[name]?.length ? { schemes: goal.schemes[name] } : {}) })),
    steps: [],
    used: new Set(),
    cost: 0,
  };

  // Identifier shapes each learned scheme was seen with: a fan-out through a scheme uses only those items.
  const shapes = new Map(graph.identities.evidence().length ? graph.identities.schemes(graph.list()).map((s) => [s.id, s.shapes]) : []);

  const results: Plan[] = [];
  const linkTargets = new Set(caps.flatMap(c => (c.links ?? []).map(l => l.target)));
  const seen = new Set<string>();
  // Values are shared by descendant search nodes. Parse each name once in this
  // search; nothing is retained across calls or changes to the graph/intent.
  const bindingValues = new WeakMap<Value, BindingValue>();
  const describeValue = (v: Value): BindingValue => {
    let info = bindingValues.get(v);
    if (!info) {
      const leaf = v.ref.replace(/^(\$in|\d+)\./, "").split(".").pop() ?? "";
      const leafToks = v.step >= 0 ? tokenize(leaf) : [];
      info = {
        callerName: v.step === -1 ? v.ref.slice(4).toLowerCase().replace(/[^a-z0-9]/g, "") : "",
        leaf,
        intentBonus: leafToks.length ? (5 * leafToks.filter((t) => intent.has(t)).length) / leafToks.length : 0,
      };
      bindingValues.set(v, info);
    }
    return info;
  };
  let frontier: Node[] = [start];
  for (let depth = 0; depth < maxSteps && frontier.length; depth++) {
    const next: Node[] = [];
    let expansions = 0;
    for (const node of frontier) {
      if (expansions > depthBudget) break;
      const consumed = consumedSteps(node);
      const covered = new Set(node.steps.flatMap((st) => [...tokensOf(graph.get(st.capability)!)]).filter((t) => intent.has(t)));
      for (const cap of caps) {
        if (node.used.has(cap.id)) continue;
        const declared = linkTargets.has(cap.id) ? node.steps.flatMap((s, index) => s.bindings.some(b => b.each) ? [] :
          (graph.get(s.capability)?.links ?? []).filter(l => l.target === cap.id).map(link => ({ index, link }))) : [];
        // An anchored program's optional stdin may read an earlier anchored step's output: the
        // caller named both, so the order they named is the pipeline. Elsewhere optional ports
        // still take only the caller's value of that name.
        const requestedBindings = goal.inputBindings?.[cap.id];
        const stdin = cap.invoke.kind === "cli" && anchors.has(cap.id) ? cap.invoke.stdin : undefined;
        const pipe = stdin === undefined ? undefined : { port: stdin,
          from: (v: Value) => v.step >= 0 && (anchorOrder.get(node.steps[v.step].capability) ?? Infinity) < anchorOrder.get(cap.id)! };
        let bindings: Binding[] | null;
        if (declared.length) {
          // Never combine parameters from different relationships or choose
          // between ambiguous links. Explicit caller inputs still use normal binding.
          const named = new Set(node.values.filter(v => v.step === -1).map(v => v.ref.slice(4)));
          const explicit = declared.every(({ link }) => link.parameters.every(p => named.has(p.port)));
          if (explicit) bindings = bind(cap, node.values, describeValue, consumed, shapes, pipe, requestedBindings);
          else if (declared.length !== 1) bindings = null;
          else {
            const { index, link } = declared[0];
            const linked: Binding[] = link.parameters.map(p => ({ port: p.port, from: `${index}.`,
              link: { name: link.name, status: link.status, pointer: p.pointer, wire: p.wire, ...(p.format ? { format: p.format } : {}) } }));
            // A declared relationship must not silently replace an explicit input binding.
            const conflicts = linked.some(b => requestedBindings && Object.hasOwn(requestedBindings, b.port));
            const rest = conflicts ? null : bind({ ...cap, inputs: cap.inputs.filter(p => !linked.some(b => b.port === p.name)) }, node.values, describeValue, consumed, shapes, pipe, requestedBindings);
            bindings = rest && validLinkGroup(graph.get(node.steps[index].capability), cap, [...linked, ...rest]) ? [...linked, ...rest] : null;
          }
        } else bindings = bind(cap, node.values, describeValue, consumed, shapes, pipe, requestedBindings);
        if (!bindings) continue;
        if (++expansions > depthBudget) break;
        // A step must consume something produced or supplied, not only constants,
        // and every step after the first must build on an earlier step's output,
        // unless the caller anchored it: anchored steps may start parallel branches
        // that a later step joins (fan-in: two systems' outputs feeding a third).
        if (cap.inputs.length && !bindings.length) continue;
        if (node.steps.length && !anchors.has(cap.id) && !bindings.some((b) => !b.from.startsWith("$in."))) continue;
        const stepIndex = node.steps.length;
        // A fan-out step yields, for each output, the list of what every item produced.
        const fans = bindings.some((b) => b.each);
        const produced: Value[] = cap.outputs.map((o) => ({
          ref: `${stepIndex}.${o.name}`,
          type: fans ? `list:${o.type}` : o.type,
          step: stepIndex,
          // Schemes describe one level of list: a list of lists carries none.
          ...(o.schemes?.length && !(fans && o.type.startsWith("list:")) ? { schemes: o.schemes } : {}),
        }));
        // Prune steps that add no new type to the state, unless they finish the goal.
        const finishes = produced.some((v) => satisfies(goal.want, v.type));
        // Required information is progress even without a new type (json -> json carrying "resolution").
        const informs = !!goal.require?.length && goal.require.some((t) => [...cap.outputs.map((o) => o.name), ...(cap.fields ?? []).map((f) => f.path)].some((path) => carries(path, t)));
        // So is intent: a type-preserving transformation (html -> corrected html) that covers intent
        // words the plan has not covered yet is progress, even as an intermediate step.
        const advances = [...tokensOf(cap)].some((t) => intent.has(t) && !covered.has(t));
        const novel = informs || advances || !!cap.links?.some(l => caps.some(c => c.id === l.target)) || produced.some((v) => !node.values.some((h) => h.type === v.type && (v.schemes ?? []).every((s) => h.schemes?.includes(s))));
        if (!novel && !finishes && !anchors.has(cap.id)) continue;
        const child: Node = {
          values: [...node.values, ...produced],
          steps: [...node.steps, { capability: cap.id, bindings }],
          used: new Set([...node.used, cap.id]),
          cost: node.cost + ledger.cost(cap.id) + (fans ? FANOUT_COST : 0),
        };
        const key = child.steps.map((s) => `${s.capability}(${s.bindings.map((b) => (b.each ? "*" : "") + b.from).join(",")})`).join(">");
        if (seen.has(key)) continue;
        seen.add(key);

        const hit = produced
          .map((v) => ({ v, d: distance(goal.want, v.type), s: outputScore(v.ref, intent, goal.want) }))
          .filter((x) => satisfies(goal.want, x.v.type))
          .sort((a, b) => a.d - b.d || b.s - a.s)[0];
        if (hit) {
          const p = finalize(graph, child, hit.v, hit.d, intent, goal.want, goal.require, goal.have, goal.schemes ?? {});
          if (p) results.push(p);
        }
        next.push(child);
      }
    }
    // Beam: keep the cheapest, most on-intent partial plans.
    frontier = next
      .map((n) => ({ n, anchored: anchorsIn(n, anchors), score: n.cost - intentOf(graph, n, intent) * 0.5 }))
      // Routes through the caller's anchors are never pruned, however poor their history.
      .sort((a, b) => b.anchored - a.anchored || a.score - b.score)
      .map((x) => x.n)
      .slice(0, 150);
  }

  // Inputs the caller supplied are part of the question: a plan that ignores one answers a
  // different question ("USD to EUR" answered without EUR). Fewer ignored inputs rank first.
  const supplied = Object.keys(goal.have);
  const ignoredInputs = new WeakMap<Plan, number>();
  const ignored = (p: Plan) => {
    const cached = ignoredInputs.get(p);
    if (cached !== undefined) return cached;
    const used = new Set(p.steps.flatMap((s) => s.bindings.map((b) => b.from)).filter((f) => f.startsWith("$in.")).map((f) => f.slice(4).split(".")[0]));
    const count = supplied.filter((k) => !used.has(k)).length;
    ignoredInputs.set(p, count);
    return count;
  };
  // With required information: established beats unverified beats incomplete, then coverage.
  const rank = (p: Plan) => (p.satisfaction ? STATUS_RANK[p.satisfaction.status] : 0);
  const coverage = (p: Plan) => (p.satisfaction ? Object.keys(p.satisfaction.covered).length : 0);
  const ranked = dedupe(results)
    .filter((p) => !intent.size || p.intentScore > 0 || anchors.size || coverage(p) > 0)
    .filter((p) => [...anchors].every((a) => p.steps.some((s) => s.capability === a)))
    .sort(
      (a, b) =>
        rank(b) - rank(a) || coverage(b) - coverage(a) ||
        Math.floor(b.fit) - Math.floor(a.fit) || ignored(a) - ignored(b) || b.intentScore - a.intentScore || b.fit - a.fit || b.resultScore - a.resultScore || a.cost - b.cost || a.steps.length - b.steps.length,
    );
  // A plan that contains another plan's steps plus more, without covering more of the intent or
  // the required information, carries a step that only transforms the data on the way (a text
  // typeset as a manual page before being dumped): the smaller plan answers the question.
  const capsOf = (p: Plan) => p.steps.map((st) => st.capability);
  const bloated = (p: Plan) => ranked.some((q) => q !== p && q.steps.length < p.steps.length && capsOf(q).every((c) => capsOf(p).includes(c)) && q.intentScore >= p.intentScore && rank(q) >= rank(p) && coverage(q) >= coverage(p));
  const lean = ranked.filter((p) => !bloated(p));
  // Drop plans that merely extend a kept plan without covering more of the intent.
  const kept: Plan[] = [];
  for (const p of lean) {
    const ids = p.steps.map((s) => s.capability).join(">");
    // ...unless it carries more of the required information or reaches a better status.
    const redundant = kept.some((k) => k.intentScore >= p.intentScore && rank(k) >= rank(p) && coverage(k) >= coverage(p) && ids.startsWith(k.steps.map((s) => s.capability).join(">") + ">"));
    if (!redundant) kept.push(p);
    if (kept.length >= limit) break;
  }
  return kept;
}

/** Does a produced type answer the goal? Markup is not the "text" a caller asked for. */
function satisfies(want: SemType, got: SemType): boolean {
  const d = distance(want, got);
  if (d < 0 || d > 1) return false;
  return !(want === "text" && (got === "html" || got === "markdown"));
}

const CONTENT = /(^|\.)(extract|summary|description|content|text|body|answer|result|translated\w*|message|output|response)$/i;

/** Prefer content-bearing outputs (extract, summary) and ones named like the intent. */
function outputScore(ref: string, intent: Set<string>, want?: SemType): number {
  const path = ref.replace(/^\d+\./, "");
  // Asked for structured data: the complete result beats any fragment of it.
  if (want === "json") return path === "" ? 3 : 1 - path.split(".").length * 0.1;
  let s = CONTENT.test(path) ? 2 : 0;
  for (const t of tokenize(path)) if (intent.has(t)) s += 1;
  if (path === "") s += 0.5;
  return s - path.split(".").length * 0.1;
}

/**
 * Can `port` take the items of list value `v` one at a time? Only for read-only capabilities and
 * required single-value ports, and only when each item is known to fit: through a shared learned
 * scheme (then only items of the scheme's observed shapes are used), or through a specific type.
 * Everywhere else a list still never fills a single-value port.
 */
function fanOut(cap: Capability, port: Port, v: Value, shapes: Map<string, string[]>): Binding["each"] | undefined {
  if (cap.risk !== "read" || !port.required || port.enum || port.type.startsWith("list:") || !v.type.startsWith("list:")) return undefined;
  const item = v.type.slice(5);
  if (schemeFits(port, item, v.schemes)) {
    const seen = [...new Set(port.schemes!.filter((s) => v.schemes!.includes(s)).flatMap((s) => shapes.get(s) ?? []))].sort();
    return { max: FANOUT_MAX, ...(seen.length ? { shapes: seen } : {}) };
  }
  if (UNSPECIFIC.test(port.type) || !accepts(port.name, port.type, item, port.anyText)) return undefined;
  return { max: FANOUT_MAX };
}

/** Bind every required input of `cap` to the best available value, or null. At most one port fans out. */
function bind(cap: Capability, values: Value[], describeValue: (v: Value) => BindingValue, consumed: Set<number>, shapes: Map<string, string[]>,
  pipe?: { port: string; from: (v: Value) => boolean }, requested?: Record<string, string>): Binding[] | null {
  // Score every acceptable value for every port first, then bind the most
  // constrained ports first, preferring values from branches nobody has used
  // yet, so a join draws each input from a different upstream system.
  const options = cap.inputs.map((port) => {
    const scored: Array<{ v: Value; score: number; each?: Binding["each"] }> = [];
    const portName = port.name.toLowerCase().replace(/[^a-z0-9]/g, "");
    for (const v of values) {
      // A caller input named after an entity ("province") identifies it: it can fill id.province.
      // A caller input given under the port's own name is that value (a "purl" is a purl, even if the
      // contract types it url); and a caller input named after an entity identifies it (id.province).
      const { callerName, leaf, intentBonus } = describeValue(v);
      // An explicit binding is a constraint, not a hint: no fallback if it cannot bind.
      const explicitlyNamed = requested && Object.hasOwn(requested, port.name) ? requested[port.name] : undefined;
      if (explicitlyNamed !== undefined && v.ref !== `$in.${explicitlyNamed}`) continue;
      const stringLike = (t: string) => !/^(number|boolean|json|list:|quantity:|geo\.)/.test(t);
      // ...and a caller value given under the port's exact name goes to that port even when it is a
      // list or JSON port (options, files): the caller named it.
      const bridged = v.step === -1 && (port.type === `id.${callerName}` || ((callerName === portName || explicitlyNamed !== undefined) && ((stringLike(port.type) && stringLike(v.type)) || port.type.startsWith("list:") || port.type === "json")));
      // Observed to carry the same identifiers, whatever each contract calls them.
      const linked = schemeFits(port, v.type, v.schemes);
      let each: Binding["each"] | undefined;
      if (!bridged && !linked && !accepts(port.name, port.type, v.type, port.anyText) && !(each = fanOut(cap, port, v, shapes))) continue;
      if (!linked && !each && v.step >= 0 && schemeOnly(port)) continue;
      // Optional ports are only filled when the caller supplied them by name.
      if (!port.required && v.ref !== `$in.${port.name}` && explicitlyNamed === undefined && !(pipe?.port === port.name && pipe.from(v))) continue;
      // A port with a fixed set of allowed values takes a caller's choice, never another step's output.
      if (port.enum && v.step >= 0) continue;
      // Name-like ports (title, name, q) take names, not prose fields like body/description.
      if (isNominal(port.name, port.type) && CONTENT.test(leaf)) continue;
      // Prefer exact types, recent values, the caller's names, and values named like the intent.
      const d = bridged || linked ? 0 : distance(port.type, each ? v.type.slice(5) : v.type);
      const nameBonus = v.ref === `$in.${port.name}` ? (port.type === "text" ? 1.5 : 5) : 0;
      // Only produced values earn the precomputed intent bonus.
      const contentBonus = port.type === "text" && CONTENT.test(leaf) ? 2 : 0;
      // The caller's own value of the exact type beats one derived through a detour.
      // (Identities only: free text is meant to be transformed, so the latest version wins.)
      const callerBonus = v.step === -1 && d === 0 && port.type !== "text" ? 3 : 0;
      // A single value that fits beats mapping over a list.
      const fanPenalty = each ? 4 : 0;
      // Evidence beats a guess: values seen to carry a port's identifiers (one, or a list of them)
      // outrank values that only share its declared type, which lexical inference can get wrong.
      const evidenceBonus = linked || (each && schemeFits(port, v.type.slice(5), v.schemes)) ? 5 : 0;
      scored.push({ v, score: d * 3 - 2 * v.step - nameBonus - intentBonus - contentBonus - callerBonus - evidenceBonus + fanPenalty, ...(each ? { each } : {}) });
    }
    return { port, scored };
  });
  const used = new Set(consumed);
  const chosen = new Map<string, { v: Value; each?: Binding["each"] }>();
  let fanned = false;
  // Two ports of one operation are two different questions: given another acceptable value,
  // do not feed the same value to both ("from USD to USD" while the caller's EUR sits unused).
  const boundRefs = new Set<string>();
  for (const { port, scored } of [...options].sort((a, b) => a.scored.length - b.scored.length)) {
    let best: Value | undefined;
    let bestEach: Binding["each"] | undefined;
    let bestScore = Infinity;
    for (const { v, score, each } of scored) {
      // One list per step: two fanned ports would ask for a cross product nobody chose.
      if (each && fanned) continue;
      // Two required inputs of one operation fed the same value is degenerate (a file compared
      // with itself): refused, not merely discouraged.
      if (port.required && boundRefs.has(v.ref)) continue;
      const s = score - (v.step >= 0 && !used.has(v.step) ? 3 : 0) + (boundRefs.has(v.ref) ? 6 : 0);
      if (s < bestScore) {
        bestScore = s;
        best = v;
        bestEach = each;
      }
    }
    if (best) {
      chosen.set(port.name, { v: best, ...(bestEach ? { each: bestEach } : {}) });
      if (bestEach) fanned = true;
      boundRefs.add(best.ref);
      if (best.step >= 0) used.add(best.step);
    } else if (port.required || (requested && Object.hasOwn(requested, port.name))) return null;
  }
  return cap.inputs
    .filter((p) => chosen.has(p.name))
    .map((p) => {
      const { v, each } = chosen.get(p.name)!;
      return { port: p.name, from: v.ref, ...(each ? { each } : {}) };
    });
}

/** Steps whose outputs some later step already uses. */
function consumedSteps(node: Node): Set<number> {
  const out = new Set<number>();
  for (const s of node.steps) for (const b of s.bindings) {
    const m = /^(\d+)\./.exec(b.from);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

/** How many distinct intent terms the plan covers. Junk steps add nothing. */
function anchorsIn(node: Node, anchors: Set<string>): number {
  let n = 0;
  for (const s of node.steps) if (anchors.has(s.capability)) n++;
  return n;
}

/**
 * Plans should use what the caller supplied: +1 per distinct input used, +0.25 per input that
 * lands in a same-named port or in a port of the identifier scheme the input was recognised as.
 */
function fitOf(graph: CapabilityGraph, node: Node): number {
  const used = new Set<string>();
  const named = new Set<string>();
  for (const s of node.steps)
    for (const b of s.bindings)
      if (b.from.startsWith("$in.")) {
        used.add(b.from);
        if (b.from.slice(4).toLowerCase() === b.port.toLowerCase()) named.add(b.from);
        const v = node.values.find((x) => x.ref === b.from);
        const port = graph.get(s.capability)?.inputs.find((p) => p.name === b.port);
        if (v && port && schemeFits(port, v.type, v.schemes)) named.add(b.from);
      }
  return used.size + named.size * 0.25;
}

const TOKENS = new WeakMap<Capability, Set<string>>();

export function tokensOf(c: Capability): Set<string> {
  let t = TOKENS.get(c);
  // What a capability *is* (title, tags), not incidental words in its prose
  // description ("rate limit: 200 req/s" must not satisfy "exchange rates").
  if (!t) TOKENS.set(c, (t = new Set(tokenize(`${c.title} ${c.tags.join(" ")}`))));
  return t;
}

/**
 * How many distinct intent terms the plan covers, from what its steps are
 * (title, description, tags) and the values it actually uses. Output fields a
 * plan merely could produce don't count, so junk steps add nothing.
 */
function intentOf(graph: CapabilityGraph, node: Node, intent: Set<string>, resultRef?: string): number {
  if (!intent.size) return 0;
  const covered = new Set<string>();
  const used = [...node.steps.flatMap((s) => s.bindings.map((b) => b.from)), ...(resultRef ? [resultRef] : [])];
  const leafTokens = new Set(used.flatMap((r) => tokenize(r.replace(/^(\$in|\d+)\./, ""))));
  for (const s of node.steps) {
    const toks = tokensOf(graph.get(s.capability)!);
    for (const t of intent) if (toks.has(t) || leafTokens.has(t)) covered.add(t);
  }
  return covered.size;
}

function finalize(graph: CapabilityGraph, node: Node, v: Value, d: number, intent: Set<string>, want?: SemType, require?: string[], have: Record<string, SemType> = {}, haveSchemes: Record<string, string[]> = {}): Plan | null {
  // Drop trailing steps that don't contribute to the result.
  const needed = new Set<number>([v.step]);
  for (let i = node.steps.length - 1; i >= 0; i--) {
    if (!needed.has(i)) continue;
    for (const b of node.steps[i].bindings) {
      const m = /^(\d+)\./.exec(b.from);
      if (m) needed.add(Number(m[1]));
    }
  }
  if (needed.size !== node.steps.length) return null; // a shorter plan covers this
  const providers = [...new Set(node.steps.map((s) => graph.get(s.capability)!.provider))];
  const titles = node.steps.map((s) => graph.get(s.capability)!.title + (s.bindings.some((b) => b.each) ? " (each)" : ""));
  const intentScore = intentOf(graph, node, intent, v.ref);
  const last = graph.get(node.steps[v.step].capability)!;
  // A crystallized pipeline is judged by the result it was proven on.
  let resultScore = last.invoke.kind === "composite" ? outputScore(last.invoke.result, intent, want) : outputScore(v.ref, intent, want);
  // The whole result of a step that *is* the intent (Summarize for "summary") is content.
  if (/^\d+\.$/.test(v.ref) && [...tokensOf(last)].some((t) => intent.has(t))) resultScore += 2;
  return {
    steps: node.steps,
    result: v.ref,
    resultType: v.type,
    cost: node.cost + d * 0.5,
    intentScore,
    fit: fitOf(graph, node),
    resultScore,
    providers,
    summary: titles.join(" → "),
    ...(require?.length ? { satisfaction: assess(graph, node.steps, v.ref, require, have, haveSchemes) } : {}),
  };
}

function dedupe(plans: Plan[]): Plan[] {
  const seen = new Set<string>();
  return plans.filter((p) => {
    // Order-independent: parallel branches in a different order are the same pipeline.
    const m = /^(\d+)\.(.*)$/.exec(p.result);
    const resultCap = m ? p.steps[Number(m[1])].capability + "." + m[2] : p.result;
    const k = p.steps.map((s) => s.capability).sort().join(">") + "#" + resultCap;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
