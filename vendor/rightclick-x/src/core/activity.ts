// Bounded, local observations for the dashboard. These are neither grants nor
// attestations. Deliberately exclude arguments, responses, predicates and errors.
import { signature, type CapabilityGraph, type GraphEvent } from "./graph.ts";
import type { Capability } from "./types.ts";

export interface ContractReference { capability: string; provider: string; contract: string }
export interface ActivityFact {
  kind: string;
  status: string;
  subjects?: string[];
  providers?: string[];
  runs?: string[];
  related?: string;
  reason?: string;
  verification?: string;
  durationMs?: number;
  predicates?: number;
  predicatesPassed?: number;
  witnessRuns?: string[];
  witnessesPassed?: number;
  attempts?: number;
  plans?: number;
  receipt?: string;
  contracts?: ContractReference[];
  truncated?: boolean;
}
export interface ActivityEntry extends ActivityFact { id: string; seq: number; epoch: string; at: string }
export interface ActivityState { version: 1; sequence: number; discarded: number; entries: ActivityEntry[] }
export const ACTIVITY_LIMIT = 500;
const REFERENCES_LIMIT = 128;

/** A non-security change detector. It cannot establish authenticity or behaviour. */
export const observedContract = (c: Capability) => `${signature(c)}:${c.provider}:${c.risk}:${c.source}`;
export const reference = (c: Capability): ContractReference => ({ capability: c.id, provider: c.provider, contract: observedContract(c) });

// Pick fields on both write and restore: legacy/corrupt state cannot inject a raw
// response into this intentionally narrow surface. IDs are metadata, not secrets.
function summary(raw: ActivityFact): ActivityFact {
  const out: ActivityFact = { kind: String(raw.kind).slice(0, 80), status: String(raw.status).slice(0, 80) };
  let budget = 8192;
  const str = (s: string) => {
    const n = Math.min(2048, budget);
    if (s.length > n) out.truncated = true;
    const value = s.slice(0, n); budget -= value.length;
    return value;
  };
  for (const key of ["subjects", "providers", "runs", "witnessRuns"] as const) {
    const list = raw[key];
    if (!Array.isArray(list)) continue;
    if (list.length > REFERENCES_LIMIT) out.truncated = true;
    out[key] = list.slice(0, REFERENCES_LIMIT).filter(v => typeof v === "string").map(str);
  }
  for (const key of ["related", "reason", "verification", "receipt"] as const) if (typeof raw[key] === "string") out[key] = str(raw[key]);
  for (const key of ["durationMs", "predicates", "predicatesPassed", "witnessesPassed", "attempts", "plans"] as const) {
    const n = raw[key];
    if (typeof n === "number" && Number.isFinite(n) && n >= 0) out[key] = n;
  }
  if (Array.isArray(raw.contracts)) {
    if (raw.contracts.length > REFERENCES_LIMIT) out.truncated = true;
    out.contracts = raw.contracts.slice(0, REFERENCES_LIMIT).filter(c => c && typeof c.capability === "string" && typeof c.provider === "string" && typeof c.contract === "string").map(c => ({ capability: str(c.capability), provider: str(c.provider), contract: str(c.contract) }));
  }
  if (raw.truncated) out.truncated = true;
  return out;
}

export class ActivityLog {
  readonly epoch = crypto.randomUUID();
  private sequence = 0;
  private discarded = 0;
  private entries: ActivityEntry[] = [];

  append(fact: ActivityFact): ActivityEntry {
    const seq = ++this.sequence;
    const entry = { ...summary(fact), id: `${this.epoch}:${seq}`, epoch: this.epoch, seq, at: new Date().toISOString() };
    this.entries.push(entry);
    if (this.entries.length > ACTIVITY_LIMIT) { this.entries.shift(); this.discarded++; }
    return structuredClone(entry);
  }

  restore(raw?: ActivityState): void {
    if (!raw || raw.version !== 1 || !Array.isArray(raw.entries)) return;
    const valid = raw.entries.filter(e => e && Number.isSafeInteger(e.seq) && e.seq > 0 && typeof e.epoch === "string" && /^[a-f0-9-]{36}$/.test(e.epoch) && e.id === `${e.epoch}:${e.seq}` && typeof e.at === "string" && Number.isFinite(Date.parse(e.at)) && typeof e.kind === "string" && typeof e.status === "string");
    // Retain a strict monotonic suffix; malformed records never become executable state.
    this.entries = [];
    for (const e of valid.slice(-ACTIVITY_LIMIT)) if (e.seq > (this.entries.at(-1)?.seq ?? 0)) this.entries.push({ ...summary(e), id: e.id, epoch: e.epoch, seq: e.seq, at: e.at });
    this.sequence = Math.max(this.entries.at(-1)?.seq ?? 0, Number.isSafeInteger(raw.sequence) && raw.sequence >= 0 ? raw.sequence : 0);
    this.discarded = (Number.isSafeInteger(raw.discarded) && raw.discarded >= 0 ? raw.discarded : 0) + raw.entries.length - this.entries.length;
  }

  snapshot(): ActivityState { return structuredClone({ version: 1, sequence: this.sequence, discarded: this.discarded, entries: this.entries }); }

  read(opts: { after?: number; epoch?: string; limit?: number } = {}) {
    const limit = Number.isFinite(opts.limit) ? Math.max(1, Math.min(100, Math.floor(opts.limit!))) : 50;
    const oldest = this.entries[0]?.seq ?? this.sequence + 1;
    const reset = opts.epoch && opts.epoch !== this.epoch ? "runtime-restarted" : opts.after !== undefined && (!Number.isSafeInteger(opts.after) || opts.after < oldest - 1 || opts.after > this.sequence) ? "history-gap" : null;
    const entries = opts.after === undefined || reset ? this.entries.slice(-limit) : this.entries.filter(e => e.seq > opts.after!).slice(0, limit);
    return { epoch: this.epoch, cursor: this.sequence, oldest, discarded: this.discarded, reset, hasMore: (entries.at(-1)?.seq ?? this.sequence) < this.sequence, entries: structuredClone(entries), scope: "Local runtime observations, not independent attestations. Arguments, responses and raw errors are omitted; identifiers and receipt references remain. History is bounded to 500 records." };
  }

  latest(subject: string): ActivityEntry | undefined {
    const e = this.entries.findLast(e => (e.kind === "execution.finished" || e.kind === "composition.finished") && e.subjects?.includes(subject));
    return e ? structuredClone(e) : undefined;
  }

  /** A later refusal may contain only the goal itself, not its dependencies.
   * Preserve the last completed observation for structural validity checks;
   * this is historical evidence, never current permission or outcome success. */
  latestCompleted(subject: string): ActivityEntry | undefined {
    const e = this.entries.findLast(e => (e.kind === "execution.finished" || e.kind === "composition.finished") &&
      e.status === "completed" && e.subjects?.includes(subject));
    return e ? structuredClone(e) : undefined;
  }

  forRun(id: string): ActivityEntry | undefined {
    const e = this.entries.findLast(e => e.kind === "execution.finished" && e.runs?.includes(id));
    return e ? structuredClone(e) : undefined;
  }

  observe(e: GraphEvent, graph: CapabilityGraph): void {
    // Never copy arbitrary graph-event payloads (sources and errors can contain credentials).
    if (!["provider.learned", "provider.forgotten", "provider.withdrawn", "provider.drifted", "capability.crystallized", "capability.retired", "goal.published"].includes(e.kind)) return;
    const d = e.data;
    const strings = (v: unknown) => Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : [];
    const subjects = typeof d.id === "string" ? [d.id] : typeof d.slug === "string" ? [`goal:${d.slug}`] : [...strings(d.capabilities), ...strings(d.removed), ...strings(d.modified), ...strings(d.retired)];
    const providers = typeof d.provider === "string" ? [d.provider] : [...strings(d.providers), ...strings(d.providersBefore), ...strings(d.providersAfter)];
    this.append({ kind: e.kind, status: "observed", subjects, providers: [...new Set(providers)], contracts: subjects.flatMap(id => { const c = graph.get(id); return c ? [reference(c)] : []; }) });
  }
}
