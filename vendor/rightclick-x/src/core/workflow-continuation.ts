// Local execution state, never an authorization grant or an effect-settlement
// decision. A dispatch without a recorded result remains unresolved.
import { isSensitiveName, redactText } from "./secrets.ts";
import type { OutcomeWitness, Predicate } from "./verify.ts";
import type { Capability, CapabilityAnchor, SemType } from "./types.ts";
import type { Plan } from "./planner.ts";

/** A selected plan, not a new discoverable capability or retained authority. */
export interface CompositionContinuation {
  id: string;
  risk: Capability["risk"];
  plan: Plan;
  types: Record<string, SemType>;
  options: {
    want: SemType; intent?: string; verify?: Predicate[]; crystallize?: boolean;
    publish?: string; risks?: Capability["risk"][]; through?: string[]; maxSteps?: number;
    inputBindings?: Record<string, Record<string, string>>;
  };
  anchors: CapabilityAnchor[];
  fixed: Record<string, unknown>;
  origins?: string[];
  witnesses: OutcomeWitness[];
  require: string[];
  preservesInput: boolean;
  /** Snapshot of the prior publication at dispatch; null means the slug was unused. */
  publicationExpected?: string | null;
  goals: Array<{ slug: string; digest: string }>;
}

export interface WorkflowContinuation {
  version: 1;
  runId: string;
  capability: string;
  contractDigest: string;
  stepDigests: string[];
  createdAt: number;
  expiresAt: number;
  inputs: Record<string, unknown>;
  verify: Predicate[];
  outputs: unknown[];
  runs: string[];
  next: number;
  phase: "ready" | "dispatching" | "waiting" | "checking" | "stopped";
  childRunId?: string;
  composition?: CompositionContinuation;
  compositionDigest?: string;
}

/** Refuse loss or recognizable credentials; do not redact executable values. */
export function checkpointValue(value: unknown, depth = 0): boolean {
  if (depth > 16) return false;
  if (value === null || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return redactText(value) === value;
  if (typeof value !== "object") return false;
  if (Array.isArray(value)) return value.every(v => checkpointValue(v, depth + 1));
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  return Object.entries(value).every(([k, v]) => !isSensitiveName(k) && checkpointValue(v, depth + 1));
}

export function validWorkflow(c: WorkflowContinuation): boolean {
  try {
    const id = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
    const hash = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v);
    return c.version === 1 && id(c.runId, 128) && id(c.capability, 512) && hash(c.contractDigest) &&
      Array.isArray(c.stepDigests) && c.stepDigests.length > 0 && c.stepDigests.length <= 16 && c.stepDigests.every(hash) &&
      Number.isFinite(c.createdAt) && Number.isFinite(c.expiresAt) && c.expiresAt >= c.createdAt &&
      c.expiresAt - c.createdAt <= 3_600_000 && c.inputs !== null && typeof c.inputs === "object" && !Array.isArray(c.inputs) &&
      Array.isArray(c.verify) && c.verify.length <= 32 && Array.isArray(c.outputs) &&
      Number.isInteger(c.next) && c.next >= 0 && c.next <= c.stepDigests.length && c.outputs.length === c.next &&
      Array.isArray(c.runs) && c.runs.length <= 128 && c.runs.every(r => id(r, 128)) &&
      ["ready", "dispatching", "waiting", "checking", "stopped"].includes(c.phase) &&
      (c.childRunId === undefined || id(c.childRunId, 128)) &&
      (c.phase !== "waiting" || !!c.childRunId) &&
      checkpointValue(c.inputs) && checkpointValue(c.outputs) && checkpointValue(c.verify) &&
      (c.composition === undefined || (
        hash(c.compositionDigest) && c.composition.id === c.capability &&
        c.composition.plan.steps.length === c.stepDigests.length &&
        c.composition.goals.length <= 8 && c.composition.goals.every(g => id(g.slug, 512) && hash(g.digest)) &&
        checkpointValue(c.composition)
      )) &&
      new TextEncoder().encode(JSON.stringify(c)).length <= 65_536;
  } catch { return false; }
}
