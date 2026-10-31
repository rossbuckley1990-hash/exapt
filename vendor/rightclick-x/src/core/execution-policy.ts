// Operator-owned restrictions. Provider text and agent tool arguments cannot change this policy.
import type { CapabilityGraph } from "./graph.ts";
import { egressOf } from "./planner.ts";
import type { Capability, Risk } from "./types.ts";

export interface ExecutionPolicy {
  /** Omitted = unrestricted; [] = none. All configured allowlists intersect. */
  allowedRisks?: Risk[];
  allowedCapabilities?: string[];
  deniedCapabilities?: string[];
  allowedProviders?: string[];
  /** Exact HTTP(S) origins, enforced on redirects and discovery as well as execution. */
  allowedOrigins?: string[];
}

const risks = ["read", "write", "external", "destructive"];
const keys = ["allowedRisks", "allowedCapabilities", "deniedCapabilities", "allowedProviders", "allowedOrigins"];

export function parseExecutionPolicy(value: unknown): ExecutionPolicy {
  if (value === undefined) return {};
  const bad = (why: string): never => { throw new Error(`invalid execution policy: ${why}`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return bad("expected an object");
  const out: Record<string, string[]> = {};
  for (const [key, v] of Object.entries(value)) {
    if (!keys.includes(key)) return bad(`unknown field ${key}`);
    if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !x.trim() || x !== x.trim())) return bad(`${key} must be an array of nonempty strings`);
    if (key === "allowedRisks" && v.some((x) => !risks.includes(x))) return bad("unknown risk");
    if (key === "allowedOrigins") for (const x of v) {
      let url: URL;
      try { url = new URL(x); } catch { return bad(`invalid origin ${x}`); }
      if (!["http:", "https:"].includes(url.protocol) || url.origin !== x) return bad(`expected exact HTTP(S) origin, got ${x}`);
    }
    if (["allowedCapabilities", "deniedCapabilities", "allowedProviders"].includes(key) && v.some((x) => x.includes("*") && (!x.endsWith("*") || x.indexOf("*") !== x.length - 1))) return bad(`${key} supports only a trailing *`);
    out[key] = [...new Set(v)];
  }
  return out as ExecutionPolicy;
}

export const matchesPolicyId = (id: string, patterns: string[]) => patterns.some((p) => p.endsWith("*") ? id.startsWith(p.slice(0, -1)) : id === p);

/** Lower bounds from transport semantics; never evidence that a remote service is honest. */
export function consequentialRisks(c: Capability): Risk[] {
  const out = new Set<Risk>([risks.includes(c.risk) ? c.risk : "destructive"]);
  const inv = c.invoke;
  if (inv.kind === "http") {
    const method = inv.method.toUpperCase();
    if (method === "DELETE") out.add("destructive");
    else if (!["GET", "HEAD", "OPTIONS"].includes(method)) out.add("write");
  }
  if (inv.kind === "graphql" && inv.operation === "mutation") out.add("write");
  return [...out];
}

export interface ExecutionAssessment {
  capability: string;
  declaredRisk: Risk;
  consequentialRisks: Risk[];
  origins: string[] | "anywhere";
  allowed: boolean;
  requiresPlan: boolean;
  reasons: string[];
  dependencies: ExecutionAssessment[];
}

export function assessExecution(c: Capability, graph: CapabilityGraph, policy: ExecutionPolicy, ancestors = new Set<string>(), budget = { remaining: 1024 }): ExecutionAssessment {
  if (ancestors.size >= 32 || --budget.remaining < 0) return {
    capability: c.id, declaredRisk: c.risk, consequentialRisks: consequentialRisks(c), origins: "anywhere",
    allowed: false, requiresPlan: false, reasons: ["dependency analysis bound exceeded (32 levels / 1024 nodes)"], dependencies: [],
  };
  const reasons: string[] = [];
  const risk = consequentialRisks(c);
  // Aggregate composite egress from the bounded traversal below, not an unbounded second walk.
  let origins: string[] | "anywhere" = c.invoke.kind === "composite" ? [] : egressOf(c, graph);
  // Host-injected cloud bindings do not use Net. We cannot infer or enforce their destinations.
  if (c.invoke.kind === "platform" && !c.invoke.fn.startsWith("fs.")) origins = "anywhere";
  const dynamic = c.invoke.kind === "goal";
  if (policy.allowedRisks && risk.some((r) => !policy.allowedRisks!.includes(r))) reasons.push(`risk ${risk.join(", ")} outside allowedRisks`);
  if (policy.allowedCapabilities && !matchesPolicyId(c.id, policy.allowedCapabilities)) reasons.push("capability outside allowedCapabilities");
  if (policy.deniedCapabilities && matchesPolicyId(c.id, policy.deniedCapabilities)) reasons.push("capability matches deniedCapabilities");
  if (policy.allowedProviders && !matchesPolicyId(c.provider, policy.allowedProviders)) reasons.push("provider outside allowedProviders");
  const dependencies: ExecutionAssessment[] = [];
  if (ancestors.has(c.id)) reasons.push("cyclic capability dependency");
  else if (c.invoke.kind === "composite") {
    const next = new Set(ancestors).add(c.id);
    for (const id of [...new Set([...c.invoke.steps.map((s) => s.capability), ...(c.invoke.witnesses ?? []).map((w) => w.capability)])]) {
      const child = graph.get(id);
      if (!child) { reasons.push(`missing dependency ${id}`); origins = "anywhere"; continue; }
      const a = assessExecution(child, graph, policy, next, budget);
      dependencies.push(a);
      if (a.origins === "anywhere") origins = "anywhere";
      else if (origins !== "anywhere") origins = [...new Set([...origins, ...a.origins])];
      if (!a.allowed) reasons.push(`dependency ${id}: ${a.reasons.join("; ")}`);
    }
  }
  // A saved goal has no fixed route. Each newly planned leaf is checked before execution.
  if (policy.allowedOrigins && !dynamic && (origins === "anywhere" || origins.some((o) => !policy.allowedOrigins!.includes(o)))) reasons.push("egress outside allowedOrigins or not statically bounded");
  return { capability: c.id, declaredRisk: c.risk, consequentialRisks: [...new Set([...risk, ...dependencies.flatMap((d) => d.consequentialRisks)])], origins, allowed: !reasons.length, requiresPlan: dynamic || dependencies.some((d) => d.requiresPlan), reasons, dependencies };
}

export class ExecutionDenied extends Error {
  readonly assessment: ExecutionAssessment;
  constructor(assessment: ExecutionAssessment) {
    super(`blocked by execution policy: ${assessment.capability}: ${assessment.reasons.join("; ")}`);
    this.assessment = assessment;
  }
}

/** Undefined is unrestricted; an empty intersection remains an explicit deny-all. */
export function intersectOrigins(a?: string[], b?: string[]): string[] | undefined {
  return a === undefined ? b : b === undefined ? a : a.filter((o) => b.includes(o));
}
