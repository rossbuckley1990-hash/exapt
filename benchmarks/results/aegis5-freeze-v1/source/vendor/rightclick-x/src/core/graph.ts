// The live capability graph.
//
// Nodes are capabilities. A directed edge A -> B exists when some output port
// of A strongly fits some required input port of B (see semantics.strongly).
// The graph is live: reflections add and replace providers at runtime, and
// every change is an event that watchers (MCP context_watch, the dashboard
// stream, federation peers) can follow.
//
// The legacy "powers" API counts descriptors and potential typed walks through
// two or three operation nodes. These are topology statistics, not evidence of
// executable, authorised, semantically valid or verified workflows.

import { IdentityEvidence, schemeOnly } from "./identities.ts";
import { accepts, distance, isNominal, parentOf, strongly } from "./semantics.ts";
import type { Capability, Provider, Reflection, SemType } from "./types.ts";

export type GraphEventKind =
  | "provider.learned"
  | "provider.forgotten"
  | "capability.crystallized"
  | "capability.retired"
  | "goal.published"
  | "provider.drifted"
  | "provider.withdrawn"
  | "run.completed"
  | "run.pending"
  | "research";

export interface GraphEvent {
  seq: number;
  at: string;
  kind: GraphEventKind;
  data: Record<string, unknown>;
}

export interface Powers {
  capabilities: number;
  edges: number;
  chains2: number;
  chains3: number;
  total: number;
}

export interface LearnDelta {
  provider: string;
  /** Present when this provider was already known: how its contract changed. */
  drift?: { changed: boolean; added: string[]; removed: string[]; modified: string[] };
  /** Crystallized pipelines retired because a step they depend on changed or vanished. */
  retired?: string[];
  capabilitiesAdded: number;
  powersBefore: number;
  powersAfter: number;
  newPowers: number;
}

const EVENT_BUFFER = 1000;

export class CapabilityGraph {
  readonly capabilities = new Map<string, Capability>();
  readonly providers = new Map<string, Provider>();
  private adjacency: Map<string, Set<string>> | null = null;
  private powersCache: Powers | null = null;
  private events: GraphEvent[] = [];
  private seq = 0;
  private listeners = new Set<(e: GraphEvent) => void>();
  /** Identifier schemes learned from observed values; applied to every capability the graph holds. */
  readonly identities = new IdentityEvidence();

  /** Restore one complete snapshot before checking dependencies. Provider order
   * is not a lifecycle event: a later entry has not disappeared from the world. */
  restore(reflections: Reflection[]): void {
    for (const { provider, capabilities } of reflections) {
      this.dropProvider(provider.id);
      for (const cap of capabilities) this.capabilities.set(cap.id, cap);
      this.providers.set(provider.id, { ...provider, capabilityIds: capabilities.map(c => c.id) });
    }
    this.relink();
    // Removing a broken inner composite can invalidate an earlier outer one.
    while (this.retireBroken().length) { /* finite: each pass removes nodes */ }
  }

  add(reflection: Reflection): LearnDelta {
    const before = this.measure ? this.powers().total : 0;
    const { provider, capabilities } = reflection;
    const previous = this.providers.get(provider.id);
    let drift: LearnDelta["drift"];
    if (previous) {
      const old = new Map(previous.capabilityIds.map((id) => [id, this.capabilities.get(id) ? signature(this.capabilities.get(id)!) : ""]));
      const next = new Map(capabilities.map((c) => [c.id, signature(c)]));
      const added = [...next.keys()].filter((id) => !old.has(id));
      const removed = [...old.keys()].filter((id) => !next.has(id));
      const modified = [...next.keys()].filter((id) => old.has(id) && old.get(id) !== next.get(id));
      drift = { changed: !!(added.length || removed.length || modified.length), added, removed, modified };
      this.dropProvider(provider.id);
    }
    for (const cap of capabilities) this.capabilities.set(cap.id, cap);
    this.providers.set(provider.id, { ...provider, capabilityIds: capabilities.map((c) => c.id) });
    this.relink();
    const retired = this.retireBroken();
    const after = this.measure ? this.powers().total : 0;
    const delta: LearnDelta = {
      provider: provider.id,
      capabilitiesAdded: capabilities.length,
      powersBefore: before,
      powersAfter: after,
      newPowers: after - before,
      ...(drift ? { drift } : {}),
      ...(retired.length ? { retired } : {}),
    };
    this.emit("provider.learned", { ...delta, title: provider.title, source: provider.source, origin: provider.origin });
    return delta;
  }

  /** Add one capability to an existing (or synthetic) provider, e.g. a crystallized pipeline. */
  addCapability(cap: Capability, provider: Omit<Provider, "capabilityIds">): LearnDelta {
    const before = this.measure ? this.powers().total : 0;
    const existing = this.providers.get(provider.id);
    const ids = new Set(existing?.capabilityIds ?? []);
    ids.add(cap.id);
    this.providers.set(provider.id, { ...(existing ?? provider), capabilityIds: [...ids] });
    this.capabilities.set(cap.id, cap);
    this.relink();
    const after = this.measure ? this.powers().total : 0;
    return { provider: provider.id, capabilitiesAdded: 1, powersBefore: before, powersAfter: after, newPowers: after - before };
  }

  forget(providerId: string): boolean {
    if (!this.providers.has(providerId)) return false;
    const capabilities = [...this.providers.get(providerId)!.capabilityIds];
    this.dropProvider(providerId);
    this.invalidate();
    this.retireBroken();
    this.emit("provider.forgotten", { provider: providerId, capabilities });
    return true;
  }

  /**
   * Crystallized pipelines are proofs about specific contracts. When a step's
   * capability vanishes or its contract (ports, invocation) changes, the proof
   * no longer holds: retire the pipeline so the planner rebuilds it.
   */
  retireBroken(): string[] {
    const retired: string[] = [];
    for (const c of [...this.capabilities.values()]) {
      if (c.invoke.kind !== "composite") continue;
      const sigs = c.invoke.signatures;
      const broken = c.invoke.steps.some((s, i) => {
        const step = this.capabilities.get(s.capability);
        return !step || (sigs?.[i] !== undefined && sigs[i] !== signature(step));
      });
      if (!broken) continue;
      this.capabilities.delete(c.id);
      const p = this.providers.get(c.provider);
      if (p) p.capabilityIds = p.capabilityIds.filter((id) => id !== c.id);
      retired.push(c.id);
      this.emit("capability.retired", { id: c.id, title: c.title });
    }
    if (retired.length) this.invalidate();
    return retired;
  }

  private dropProvider(id: string): void {
    for (const capId of this.providers.get(id)?.capabilityIds ?? []) this.capabilities.delete(capId);
    this.providers.delete(id);
  }

  /** Re-apply learned identifier schemes to every capability (after new evidence or new capabilities). */
  relink(): void {
    this.identities.refresh();
    if (this.identities.evidence().length) this.identities.apply(this.capabilities.values());
    this.invalidate();
  }

  private invalidate(): void {
    this.adjacency = null;
    this.powersCache = null;
    this.index = null;
  }

  /** Per-change power deltas are measured only while counting is cheap. */
  measuring = true;
  private get measure(): boolean {
    return this.measuring && this.capabilities.size < 2500;
  }

  get(id: string): Capability | undefined {
    return this.capabilities.get(id);
  }

  list(): Capability[] {
    return [...this.capabilities.values()];
  }

  // ------------------------------------------------------------- structure

  /** Capabilities with a required input that strongly accepts `type`. */
  consumersOf(type: SemType): Capability[] {
    return this.list().filter((c) => c.inputs.some((p) => accepts(p.name, p.type, type)));
  }

  /** Capabilities with an output that strongly fits `type`. */
  producersOf(type: SemType): Capability[] {
    return this.list().filter((c) => c.outputs.some((p) => strongly(type, p.type)));
  }

  private index: { byInputType: Map<SemType, Set<string>>; nominal: Set<string>; byScheme: Map<string, Set<string>> } | null = null;

  /** Required inputs indexed by exact type, plus name-like ports; built once per graph version. */
  private inputIndex() {
    if (this.index) return this.index;
    const byInputType = new Map<SemType, Set<string>>();
    const nominal = new Set<string>();
    const byScheme = new Map<string, Set<string>>();
    for (const c of this.capabilities.values()) {
      for (const p of c.inputs) {
        if (!p.required) continue;
        for (const s of p.schemes ?? []) {
          const k = schemeSlot(s, p.type);
          if (!byScheme.has(k)) byScheme.set(k, new Set());
          byScheme.get(k)!.add(c.id);
        }
        if (schemeOnly(p)) continue;
        let set = byInputType.get(p.type);
        if (!set) byInputType.set(p.type, (set = new Set()));
        set.add(c.id);
        if (isNominal(p.name, p.type)) nominal.add(c.id);
      }
    }
    return (this.index = { byInputType, nominal, byScheme });
  }

  /** Capabilities that an output of `a` can feed. Walks each produced type up the lattice. */
  outSet(a: Capability): Set<string> {
    const { byInputType, nominal, byScheme } = this.inputIndex();
    const out = new Set<string>();
    for (const link of a.links ?? []) if (this.capabilities.has(link.target)) out.add(link.target);
    for (const port of a.outputs) {
      // Identifier schemes learned from observed values link ports whose declared types differ.
      for (const s of port.schemes ?? []) for (const b of byScheme.get(schemeSlot(s, port.type)) ?? []) if (b !== a.id) out.add(b);
      let t: SemType | undefined = port.type;
      while (t !== undefined) {
        if (strongly(t, port.type)) for (const b of byInputType.get(t) ?? []) if (b !== a.id) out.add(b);
        t = parentOf(t);
      }
      if (distance("text", port.type) === 1 && !["html", "markdown"].includes(port.type)) for (const b of nominal) if (b !== a.id) out.add(b);
    }
    return out;
  }

  /** Full adjacency. Materialized lazily: large graphs never need it for counting. */
  edges(): Map<string, Set<string>> {
    if (this.adjacency) return this.adjacency;
    const adj = new Map<string, Set<string>>();
    for (const a of this.capabilities.values()) adj.set(a.id, this.outSet(a));
    this.adjacency = adj;
    return adj;
  }

  /** Up to `limit` edges without materializing the whole adjacency. */
  sampleEdges(limit: number): Array<[string, string]> {
    const out: Array<[string, string]> = [];
    for (const a of this.capabilities.values()) {
      for (const b of this.outSet(a)) {
        out.push([a.id, b]);
        if (out.length >= limit) return out;
      }
    }
    return out;
  }

  /**
   * Streaming count, O(edges) time and O(nodes) memory: pass 1 records each
   * node's out-degree, pass 2 sums the out-degrees of every node's successors
   * (a→b→c walks with c ≠ b).
   */
  powers(): Powers {
    if (this.powersCache) return this.powersCache;
    const outdeg = new Map<string, number>();
    let edges = 0;
    if (this.adjacency) for (const [a, s] of this.adjacency) outdeg.set(a, s.size);
    else for (const a of this.capabilities.values()) outdeg.set(a.id, this.outSet(a).size);
    for (const n of outdeg.values()) edges += n;
    let chains3 = 0;
    for (const a of this.capabilities.values()) {
      const succ = this.adjacency?.get(a.id) ?? this.outSet(a);
      for (const b of succ) chains3 += outdeg.get(b) ?? 0;
    }
    const capabilities = this.capabilities.size;
    this.powersCache = { capabilities, edges, chains2: edges, chains3, total: capabilities + edges + chains3 };
    return this.powersCache;
  }

  neighbors(id: string): { upstream: string[]; downstream: string[] } {
    const adj = this.edges();
    const upstream: string[] = [];
    for (const [a, outs] of adj) if (outs.has(id)) upstream.push(a);
    return { upstream, downstream: [...(adj.get(id) ?? [])] };
  }

  /** Every semantic type the graph can currently produce or consume, with counts. */
  census(): Array<{ type: SemType; producers: number; consumers: number }> {
    const m = new Map<SemType, { producers: number; consumers: number }>();
    const bump = (t: SemType, k: "producers" | "consumers") => {
      const e = m.get(t) ?? { producers: 0, consumers: 0 };
      e[k]++;
      m.set(t, e);
    };
    for (const c of this.capabilities.values()) {
      for (const t of new Set(c.outputs.map((p) => p.type))) bump(t, "producers");
      for (const t of new Set(c.inputs.map((p) => p.type))) bump(t, "consumers");
    }
    return [...m].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.producers + b.consumers - (a.producers + a.consumers));
  }

  // ---------------------------------------------------------------- search

  search(query: string, limit = 10): Array<{ capability: Capability; score: number }> {
    const terms = tokenize(query);
    if (!terms.length) return [];
    const docs = this.list().map((c) => ({ c, tokens: tokenize(docText(c)) }));
    const N = docs.length || 1;
    const avg = docs.reduce((s, d) => s + d.tokens.length, 0) / N || 1;
    const df = new Map<string, number>();
    for (const d of docs) for (const t of new Set(d.tokens)) df.set(t, (df.get(t) ?? 0) + 1);
    const scored = docs.map(({ c, tokens }) => {
      const tf = new Map<string, number>();
      for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
      let score = 0;
      for (const q of terms) {
        const f = tf.get(q) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(q) ?? 0) + 0.5) / ((df.get(q) ?? 0) + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + 0.75 * (tokens.length / avg)));
      }
      // A title containing every query term is the strongest signal.
      const title = new Set(tokenize(c.title));
      if (terms.every((t) => title.has(t))) score += 3 + 3 / title.size;
      return { capability: c, score };
    });
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  // ---------------------------------------------------------------- events

  emit(kind: GraphEventKind, data: Record<string, unknown>): GraphEvent {
    const e: GraphEvent = { seq: ++this.seq, at: new Date().toISOString(), kind, data };
    this.events.push(e);
    if (this.events.length > EVENT_BUFFER) this.events.splice(0, this.events.length - EVENT_BUFFER);
    for (const l of this.listeners) {
      try {
        l(e);
      } catch {
        /* a broken watcher must not break the graph */
      }
    }
    return e;
  }

  since(seq: number): GraphEvent[] {
    return this.events.filter((e) => e.seq > seq);
  }

  get cursor(): number {
    return this.seq;
  }

  subscribe(fn: (e: GraphEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

/** Contract signature of a capability: its typed ports and how it is invoked (FNV-1a). */
export function signature(c: Capability): string {
  const text = JSON.stringify([c.inputs.map((p) => [p.name, p.type, p.required]), c.outputs.filter((p) => !p.observed).map((p) => [p.name, p.type]), c.invoke, ...(c.links?.length ? [c.links] : [])]);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Scheme links keep cardinality: a list of identifiers fills a list port, one identifier a single port. */
function schemeSlot(scheme: string, type: SemType): string {
  return `${scheme}|${type.startsWith("list:") ? "list" : "one"}`;
}

const STOP = new Set(["the", "a", "an", "of", "to", "and", "or", "for", "in", "on", "by", "with", "is", "it", "this", "that", "from", "as", "be"]);

export function tokenize(s: string): string[] {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    // Runs of capitals: "ForACity" → "For A City", "XMLHttp" → "XML Http".
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map(stem);
}

const SUFFIXES = ["ations", "ation", "ings", "ing", "ions", "ion", "ies", "ed", "es", "er", "e", "s"];

/** Light stemmer: translate/translated/translation -> transl, weather -> weath. */
export function stem(t: string): string {
  if (t.length <= 3 || /^\d+$/.test(t)) return t;
  // Two passes so plurals reduce like their singulars (weathers -> weather -> weath).
  for (let pass = 0; pass < 2; pass++) {
    for (const s of SUFFIXES) {
      if (t.endsWith(s) && t.length - s.length >= 4) {
        t = s === "ies" ? t.slice(0, -3) + "y" : t.slice(0, -s.length);
        break;
      }
    }
  }
  if (t.length > 5 && t.endsWith("at")) t = t.slice(0, -2);
  return t;
}

function docText(c: Capability): string {
  return [
    c.title,
    c.title,
    c.description,
    c.tags.join(" "),
    c.provider,
    c.inputs.map((p) => `${p.name} ${p.type}`).join(" "),
    c.outputs.map((p) => `${p.name} ${p.type}`).join(" "),
  ].join(" ");
}
