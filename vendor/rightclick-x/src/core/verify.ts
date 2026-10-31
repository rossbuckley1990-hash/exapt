import type { GraphQLFailureEvidence, TransportRefusal } from "./types.ts";
import type { CliValidity } from "./cli-outcome.ts";
// Outcome verification: "the provider answered" is not "the job got done".
// Callers attach predicates to a run; the result is verified, refuted, or
// honestly unverified when no predicate was given.

export type Predicate =
  | { op: "exists"; path?: string }
  | { op: "equals"; path?: string; value: unknown }
  | { op: "contains"; path?: string; value: string }
  | { op: "matches"; path?: string; pattern: string }
  | { op: "type"; path?: string; value: "string" | "number" | "boolean" | "object" | "array" }
  | { op: "gt" | "lt"; path?: string; value: number }
  | { op: "length_gt"; path?: string; value: number };

export interface PredicateResult {
  predicate: Predicate;
  ok: boolean;
  actual: unknown;
}

/** A read-only environmental capability that independently checks an outcome.
 * Bindings are relative to each invocation, never frozen to the first example.
 */
export interface OutcomeWitness {
  capability: string;
  /** Runtime-pinned checker contract. Changed checkers require a new explicit proof. */
  contract?: string;
  args: Record<string, { input: string } | { output: string } | { value: unknown }>;
  verify: Predicate[];
  /** Agreement: the witness recomputes the outcome from the invocation's inputs alone, and its
   *  result must agree with the candidate. Such a witness is never given the candidate. */
  agree?: WitnessAgreement;
}

/** How an independently recomputed result must agree with the candidate. */
export interface WitnessAgreement {
  /** Path into the witness's own result; absent or empty: all of it. */
  path?: string;
  /** Path into the candidate result; absent or empty: all of it. */
  candidate?: string;
  /** exact (default): the same value; trimmed: the same text once surrounding whitespace is
   *  removed; number: numbers no further apart than tolerance. */
  mode?: "exact" | "trimmed" | "number";
  tolerance?: number;
}

export interface AgreementResult {
  mode: "exact" | "trimmed" | "number";
  ok: boolean;
  witness: unknown;
  candidate: unknown;
}

export interface WitnessResult {
  capability: string;
  runId: string;
  status: "completed" | "failed" | "pending";
  verification: { status: "verified" | "checked" | "refuted" | "unverified"; results: PredicateResult[] };
  output?: unknown;
  error?: string;
  refusal?: TransportRefusal;
  graphqlFailure?: GraphQLFailureEvidence;
  cliValidity?: CliValidity;
  agreement?: AgreementResult;
}

/** The agreement shape is checked before anything runs, so a malformed one never passes later. */
export function assertAgreement(a: unknown): asserts a is WitnessAgreement {
  if (!a || typeof a !== "object" || Array.isArray(a)) throw new Error("witness agreement must be an object");
  const { path, candidate, mode, tolerance, ...rest } = a as Record<string, unknown>;
  if (Object.keys(rest).length) throw new Error(`unknown witness agreement field: ${Object.keys(rest)[0]}`);
  if (path !== undefined && typeof path !== "string" || candidate !== undefined && typeof candidate !== "string") throw new Error("witness agreement paths must be strings");
  if (mode !== undefined && !["exact", "trimmed", "number"].includes(mode as string)) throw new Error("witness agreement mode must be exact, trimmed or number");
  if (tolerance !== undefined && (mode !== "number" || typeof tolerance !== "number" || !Number.isFinite(tolerance) || tolerance < 0)) throw new Error("witness agreement tolerance must be a finite non-negative number, with mode number");
}

/** Whether an independently recomputed result agrees with the candidate. */
export function agreement(a: WitnessAgreement, witnessOutput: unknown, candidateOutput: unknown): AgreementResult {
  const mode = a.mode ?? "exact";
  const witness = pick(witnessOutput, a.path), candidate = pick(candidateOutput, a.candidate);
  let ok = false;
  if (witness !== undefined && candidate !== undefined) {
    if (mode === "number") {
      const [w, c] = [witness, candidate].map((x) => typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN);
      ok = Number.isFinite(w) && Number.isFinite(c) && Math.abs(w - c) <= (a.tolerance ?? 0);
    } else if (mode === "trimmed") ok = typeof witness === "string" && typeof candidate === "string" ? witness.trim() === candidate.trim() : stable(witness) === stable(candidate);
    else ok = stable(witness) === stable(candidate);
  }
  return { mode, ok, witness: summarize(witness), candidate: summarize(candidate) };
}

/** JSON with object keys sorted: equal values give equal text whatever their key order. */
function stable(v: unknown): string {
  return JSON.stringify(v, (_, x) => x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x);
}

export function pick(value: unknown, path?: string): unknown {
  if (!path) return value;
  let cur: unknown = value;
  for (const seg of path.split(".")) {
    if (cur == null) return undefined;
    if (Array.isArray(cur) && /^\d+$/.test(seg)) cur = cur[Number(seg)];
    else if (Array.isArray(cur)) cur = cur.map((x) => (x as Record<string, unknown>)?.[seg]);
    else cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * Stored predicates checked by RightClick X itself on the output. Passing them is a check
 * ("checked"), not independent verification: only a separate witness provider verifies.
 */
export function check(value: unknown, predicates: Predicate[]): { status: "checked" | "refuted" | "unverified"; results: PredicateResult[] } {
  if (!predicates?.length) return { status: "unverified", results: [] };
  const results = predicates.map((p) => {
    const actual = pick(value, p.path);
    let ok = false;
    switch (p.op) {
      case "exists":
        ok = actual !== undefined && actual !== null && actual !== "";
        break;
      case "equals":
        ok = JSON.stringify(actual) === JSON.stringify(p.value);
        break;
      case "contains":
        ok = (typeof actual === "string" ? actual : JSON.stringify(actual ?? "")).includes(p.value);
        break;
      case "matches":
        ok = new RegExp(p.pattern).test(typeof actual === "string" ? actual : JSON.stringify(actual ?? ""));
        break;
      case "type":
        ok = p.value === "array" ? Array.isArray(actual) : typeof actual === p.value && !Array.isArray(actual);
        break;
      case "gt":
        ok = Number(actual) > p.value;
        break;
      case "lt":
        ok = Number(actual) < p.value;
        break;
      case "length_gt":
        ok = ((actual as { length?: number })?.length ?? 0) > p.value;
        break;
    }
    return { predicate: p, ok, actual: summarize(actual) };
  });
  return { status: results.every((r) => r.ok) ? "checked" : "refuted", results };
}

function summarize(v: unknown): unknown {
  if (typeof v === "string" && v.length > 200) return v.slice(0, 200) + "…";
  // A path-less predicate must not echo a large output back once per check.
  if (v && typeof v === "object") {
    const chars = JSON.stringify(v).length;
    if (chars > 1000) return Array.isArray(v) ? { omitted: "array", length: v.length, chars } : { omitted: "object", keys: Object.keys(v).length, chars };
  }
  return v;
}
