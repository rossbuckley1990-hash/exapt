// Versioned persistence, not authorization. The envelope deliberately makes
// audited legacy readers stop at graph restoration instead of interpreting an
// unknown version as empty state and overwriting it on their next flush.
import type { PersistedState } from "../runtime.ts";
import type { Reflection } from "./types.ts";
import { validCliEnvironment } from "./cli-environment.ts";
import { validCliConformancePin } from "./cli-conformance.ts";

export const STATE_FORMAT = "rightclick-x/runtime-state@2";
export const STATE_REQUIREMENTS = [
  "scoped-composites@1",
  "http-workflow-continuations@1",
  "composition-goal-obligations@1",
  "declared-continuation-contracts@1",
  "cli-validity@1",
  // Old runtimes must not execute newly persisted SHA-256 witness pins using
  // their collision-prone, incompatible 32-bit graph signatures.
  "witness-contract-sha256@1",
] as const;
export const CONTRACT_LINK_REQUIREMENT = "response-contract-links@1";
/** Present only when state retains reflections an inference migration could not re-derive.
 *  A reader without it refuses the state instead of saving over what it cannot interpret. */
export const DEFERRED_INFERENCE_REQUIREMENT = "deferred-inference@1";
/** Present only when state retains CLI conformance pins, so states without them stay readable by
 *  readers that predate conformance, and readers that predate it refuse states that carry pins. */
export const CLI_CONFORMANCE_REQUIREMENT = "cli-conformance@1";
/** Readers must understand these saved bindings before replanning a goal or publishing a resumed composition. */
export const STEP_INPUT_BINDINGS_REQUIREMENT = "step-input-bindings@1";
/** A resumed publication must respect its dispatch-time snapshot. */
export const PUBLICATION_SNAPSHOT_REQUIREMENT = "publication-snapshot@1";
/** File state written by cooperating compare-and-swap writers requires readers aware of that protocol. */
export const FILE_STORE_CAS_REQUIREMENT = "file-store-cas@1";
export const FILE_STORE_GOAL_LEASE_REQUIREMENT = "file-store-goal-lease@1";
const supported = new Set<string>([...STATE_REQUIREMENTS, CONTRACT_LINK_REQUIREMENT, DEFERRED_INFERENCE_REQUIREMENT, CLI_CONFORMANCE_REQUIREMENT, STEP_INPUT_BINDINGS_REQUIREMENT, PUBLICATION_SNAPSHOT_REQUIREMENT, FILE_STORE_CAS_REQUIREMENT, FILE_STORE_GOAL_LEASE_REQUIREMENT]);
export function usesStepInputBindings(state: Pick<PersistedState, "published" | "workflowContinuations">): boolean {
  return (Array.isArray(state.published) && state.published.some(g => g?.inputBindings !== undefined)) ||
    (Array.isArray(state.workflowContinuations) && state.workflowContinuations.some(w => w?.composition?.options?.inputBindings !== undefined));
}
export function usesPublicationSnapshot(state: Pick<PersistedState, "workflowContinuations">): boolean {
  return Array.isArray(state.workflowContinuations) && state.workflowContinuations.some(w =>
    w?.composition?.options?.publish !== undefined && w.composition.publicationExpected !== undefined);
}
export function usesContractLinks(reflections: Reflection[]): boolean {
  return reflections.some(r => r.capabilities.some(c => c.links?.length ||
    c.invoke.kind === "composite" && c.invoke.steps.some(s => s.bindings.some(b => b.link))));
}
const invocations = new Set(["http", "graphql", "mcp", "peer", "builtin", "platform", "cli", "goal", "composite"]);
const object = (value: unknown): value is Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Decode an existing value. Only the storage adapter can identify absence. */
export function decodeState(value: unknown): PersistedState {
  if (!object(value)) throw new Error("invalid runtime state: expected an object; existing data was not discarded");
  if ("format" in value) {
    if (value.format !== STATE_FORMAT) throw new Error(`unsupported runtime state format: ${String(value.format)}`);
    if (value.version !== 1 || !object(value.reflections) || value.reflections.requires !== STATE_FORMAT ||
        !object(value.state) || value.state.version !== 2 || "format" in value.state) {
      throw new Error("invalid runtime state envelope");
    }
    value = value.state;
  }
  const state = value as Record<string, any>;
  if (state.version !== 1 && state.version !== 2) throw new Error(`unsupported runtime state version: ${String(state.version)}`);
  if (state.version === 2 && !Array.isArray(state.requirements)) throw new Error("runtime state requirements are missing");
  if (state.requirements !== undefined && (!Array.isArray(state.requirements) ||
      state.requirements.some((r: unknown) => typeof r !== "string" || !supported.has(r)))) {
    throw new Error("unsupported runtime state requirement; use a compatible reader");
  }
  if (!Array.isArray(state.reflections) || !Array.isArray(state.receipts) || !object(state.ledger) ||
      (state.published !== undefined && !Array.isArray(state.published))) {
    throw new Error("invalid runtime state structure");
  }
  if (state.deferredInference !== undefined) {
    if (!state.requirements?.includes(DEFERRED_INFERENCE_REQUIREMENT)) throw new Error("runtime state is missing the deferred inference requirement");
    if (!Array.isArray(state.deferredInference) || state.deferredInference.some((d: unknown) =>
        !object(d) || !Number.isSafeInteger(d.semantics) || !object(d.reflection) ||
        (d.reason !== undefined && (typeof d.reason !== "string" || d.reason.length > 1000)))) {
      throw new Error("invalid deferred inference record");
    }
  }
  for (const reflection of [...state.reflections, ...(state.deferredInference ?? []).map((d: any) => d.reflection)]) {
    if (!object(reflection) || !object(reflection.provider) || !Array.isArray(reflection.capabilities)) {
      throw new Error("invalid runtime state reflection");
    }
    for (const cap of reflection.capabilities) {
      if (!object(cap) || !object(cap.invoke) || !invocations.has(cap.invoke.kind) ||
          !Array.isArray(cap.inputs) || !Array.isArray(cap.outputs)) {
        throw new Error("unsupported runtime state capability");
      }
      const pin = cap.invoke.kind === "cli" ? cap.invoke.environment : undefined;
      if (pin !== undefined && (!state.requirements?.includes("cli-validity@1") || !object(pin) ||
          pin.version !== 1 || pin.coverage !== "partial" || !/^[a-f0-9]{64}$/.test(pin.digest)))
        throw new Error("unsupported CLI environment evidence");
    }
    const environment = reflection.provider.meta?.cliEnvironment;
    if (environment !== undefined && (!state.requirements?.includes("cli-validity@1") || !validCliEnvironment(environment)))
      throw new Error("unsupported retained CLI environment observation");
  }
  if (state.cliConformance !== undefined && (!state.requirements?.includes(CLI_CONFORMANCE_REQUIREMENT) ||
      !Array.isArray(state.cliConformance) || state.cliConformance.length > 1024 ||
      state.cliConformance.some((p: unknown) => !validCliConformancePin(p)) ||
      new Set(state.cliConformance.map((p: { capability: string }) => p.capability)).size !== state.cliConformance.length))
    throw new Error("unsupported retained CLI conformance evidence");
  if (usesContractLinks(state.reflections) && !state.requirements?.includes(CONTRACT_LINK_REQUIREMENT))
    throw new Error("runtime state is missing the response contract link requirement");
  if (usesStepInputBindings(state as PersistedState) && !state.requirements?.includes(STEP_INPUT_BINDINGS_REQUIREMENT))
    throw new Error("runtime state is missing the step input bindings requirement");
  if (usesPublicationSnapshot(state as PersistedState) && !state.requirements?.includes(PUBLICATION_SNAPSHOT_REQUIREMENT))
    throw new Error("runtime state is missing the publication snapshot requirement");
  return state as PersistedState;
}

/** A bare version-1 snapshot, which the next save rewrites in the version-2 envelope. Stores keep
 *  its exact bytes and write a backup of them before that first save. */
export function isLegacyState(value: unknown): boolean {
  return object(value) && !("format" in value) && value.version === 1;
}

/** Name for the copy a migration keeps of what it replaced ("v1" or "semantics-<n>"), unique to
 *  the moment it was made. */
export function backupSuffix(replaced: string, now = new Date()): string {
  return `.${replaced}-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
}

/** What the first save after a load must keep a copy of: the loaded value, when that save changes
 *  its format or the inference version its reflections were typed with. */
export function migrationReplaces(loaded: unknown, saving: PersistedState): string | undefined {
  if (isLegacyState(loaded)) return "v1";
  const before = object(loaded) && object(loaded.state) ? loaded.state.semantics : undefined;
  return before !== saving.semantics ? `semantics-${before ?? "none"}` : undefined;
}

/** The built-in writable adapters (file, Durable Object) use this; Workers KV is read-only. Custom
 *  adapters should do likewise. */
export function encodeState(state: PersistedState): string {
  decodeState(state);
  if (state.version !== 2) throw new Error("legacy runtime state is read-only; upgrade through the runtime before saving");
  return JSON.stringify({
    format: STATE_FORMAT,
    // This is a version-2 envelope, not a valid version-1 snapshot. Known old
    // readers enter their version-1 branch and refuse this non-array before any
    // restored operation or flush. A bare version:2 would silently reset them.
    version: 1,
    reflections: { requires: STATE_FORMAT },
    state,
  });
}
