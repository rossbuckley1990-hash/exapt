// Identifier schemes learned from observed values.
//
// Providers name the same identifier differently: one contract calls a protein
// accession `accession` ("stable identifier"), another `accession` with no
// description, a third `uniprot_id`. Names and descriptions cannot settle that
// in general, but the values can. When the same identifier-shaped value is
// accepted as a key by two operations, each answering with a record that names
// that value in a key field, both input ports take one identifier scheme. When
// a value produced at an output port is later accepted that way, the output
// port feeds the scheme. Nothing here knows any provider: only runs that
// actually happened create links.
//
// Schemes are additive. Declared semantic types are never rewritten, so links
// that types already made are kept and a scheme only adds a typed link between
// ports that evidence showed to carry the same identifiers.
//
// Merging is deliberately one-sided: input ports are unified (an operation that
// looks a record up by key accepts exactly one kind of key), while an output
// port may feed several schemes without merging them, because one output (a list
// of cross-references, say) can carry identifiers of different kinds.

import { isNominal } from "./semantics.ts";
import type { Capability, Port, SemType } from "./types.ts";

export type LinkKind = "co-accept" | "echo" | "flow";

/** One piece of evidence: `from` and `to` are port keys, `value` the identifier that linked them. */
export interface IdentityLink {
  kind: LinkKind;
  from: string;
  to: string;
  value: string;
  at: string;
}

export interface IdentityState {
  links: IdentityLink[];
  /** Identifier value -> input port keys that accepted it as a key. */
  accepted: Record<string, string[]>;
  /** Observed output paths that are not declared ports: port key -> element type and whether it is a list. */
  observed?: Record<string, { list: boolean }>;
}

export interface SchemeInfo {
  id: string;
  members: string[];
  /** How each input member joined: by evidence of its own, or as a same-named sibling in the same contract. */
  via: Record<string, "evidence" | "sibling">;
  feeds: string[];
  shapes: string[];
}

const MAX_LINKS = 4000;
const MAX_ACCEPTED = 5000;
const MAX_RECENT = 20000;
const MAX_LEAVES = 20000;

/** Port key: capability, direction, port name (output paths without array indices). */
export function portKey(cap: string, dir: "in" | "out", name: string): string {
  return `${cap}\u0001${dir}\u0001${name}`;
}

export function parseKey(key: string): { cap: string; dir: "in" | "out"; name: string } {
  const [cap, dir, name] = key.split("\u0001");
  return { cap, dir: dir as "in" | "out", name };
}

/**
 * A value that can name a record: one token of letters and digits with at least one of
 * each (P04637, 4HHB, GO:0006915, TP53). Words, numbers, dates and prose cannot.
 */
export function identifierShaped(v: unknown): v is string {
  if (typeof v !== "string" || v.length < 3 || v.length > 64) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(v)) return false;
  if (!/[0-9]/.test(v) || !/[A-Za-z]/.test(v)) return false;
  return !/^\d{4}-\d{2}-\d{2}/.test(v) && !/^v?\d+(\.\d+)+$/i.test(v);
}

/** Coarse value shape used to recognise a caller's value as one of a scheme's identifiers. */
export function shapeOf(v: string): string {
  const c = v.charAt(0);
  const first = /[0-9]/.test(c) ? "9" : /[A-Z]/.test(c) ? "A" : "a";
  return `${v.length}${first}${/[:_.-]/.test(v) ? "p" : ""}`;
}

function normalize(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/** Fields in which a record names its own key (rcsb_id, primaryAccession, entry_id, accession). */
const KEY_FIELD = /(^|_)(id|ids|key|code|accession|accessions|identifier|identifiers)$/;

/** Input names too generic to mean one thing across an API's operations. */
const GENERIC_NAME = /^(id|ids|key|name|code|type|value|slug|uuid|guid|format|fields|size|limit|offset|page|sort|order|filter|selection|body|json)$/;

function isList(t: SemType): boolean {
  return t.startsWith("list:");
}

/** An output port that produced a value; `observed` when it is a path the contract does not declare. */
interface Source {
  key: string;
  observed: { list: boolean } | null;
}

interface Leaf {
  path: string;
  lists: number;
  value: string;
}

/** Identifier-shaped string leaves of a result, with their array-free paths. */
function leaves(output: unknown): Leaf[] {
  const out: Leaf[] = [];
  const walk = (v: unknown, path: string[], lists: number, depth: number) => {
    if (out.length >= MAX_LEAVES || depth > 10) return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 500)) walk(x, path, lists + 1, depth + 1);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) walk(x, [...path, k], lists, depth + 1);
      return;
    }
    if (identifierShaped(v)) out.push({ path: path.join("."), lists, value: v });
  };
  walk(output, [], 0, 0);
  return out;
}

export class IdentityEvidence {
  private links: IdentityLink[] = [];
  private accepted = new Map<string, string[]>();
  private observedPorts = new Map<string, { list: boolean }>();
  /** Value -> output ports that recently produced it (this process only). */
  private recent = new Map<string, Map<string, Source>>();
  private classes: { schemes: Map<string, SchemeInfo>; inputScheme: Map<string, string>; outputSchemes: Map<string, Set<string>> } | null = null;
  version = 0;

  load(s: IdentityState | undefined): void {
    if (!s) return;
    this.links = [...(s.links ?? [])].slice(-MAX_LINKS);
    this.accepted = new Map(Object.entries(s.accepted ?? {}));
    this.observedPorts = new Map(Object.entries(s.observed ?? {}));
    this.changed();
  }

  toJSON(): IdentityState {
    return { links: this.links, accepted: Object.fromEntries(this.accepted), observed: Object.fromEntries(this.observedPorts) };
  }

  evidence(): IdentityLink[] {
    return [...this.links];
  }

  private changed(): void {
    this.classes = null;
    this.version++;
  }

  /** The set of capabilities changed: schemes are recomputed on next use. */
  refresh(): void {
    this.classes = null;
  }

  /**
   * Learn from one completed run. `required` names the inputs the caller had to supply;
   * a path seen only when optional inputs reshaped the response is not recorded as a
   * port of the operation. Returns true when the evidence changed.
   */
  observe(cap: Capability, args: Record<string, unknown>, output: unknown, at = new Date().toISOString()): boolean {
    if (output == null || output === "") return false;
    const found = leaves(output);
    if (!found.length) return false;
    const before = this.links.length;
    const declared = new Set(cap.outputs.filter((p) => !p.observed).map((p) => p.name));
    // Optional inputs (a GraphQL selection, a `fields` list) reshape the response: paths seen only
    // then are not outputs of the operation. Declared ports stay valid whatever the request.
    // Only inputs that choose fields reshape it; an optional filter (purl OR repository_url) does not.
    const RESHAPES = /^(selection|select|fields?|include|includes|expand|embed|view|projection|properties|columns|attributes|format)$/i;
    const customised = cap.inputs.some((p) => !p.required && args[p.name] !== undefined && (RESHAPES.test(p.name) || (cap.invoke as any).selectPort === p.name));
    const source = (l: Leaf): Source | null => {
      if (declared.has(l.path)) return { key: portKey(cap.id, "out", l.path), observed: null };
      // Up to two array levels (records in a list, each with a list of identifiers): fan-out
      // flattens them. Deeper nesting is not linked.
      if (customised || l.lists > 2 || !l.path) return null;
      return { key: portKey(cap.id, "out", l.path), observed: { list: l.lists > 0 } };
    };
    const link = (kind: LinkKind, from: Source, to: string, value: string) => {
      if (this.add({ kind, from: from.key, to, value, at }) && from.observed && !this.observedPorts.has(from.key)) this.observedPorts.set(from.key, from.observed);
    };

    for (const port of cap.inputs) {
      if (port.enum || isNominal(port.name, port.type)) continue;
      const raw = args[port.name];
      const values = (Array.isArray(raw) ? raw : [raw]).filter(identifierShaped);
      if (!values.length) continue;
      const inKey = portKey(cap.id, "in", port.name);
      for (const v of values) {
        // The operation answered with a record that names this value in a key field.
        const echoes = found.filter((l) => l.value === v && KEY_FIELD.test(normalize(l.path.split(".").pop() ?? "")));
        if (!echoes.length) continue;
        for (const l of echoes) {
          const s = source(l);
          if (s) link("echo", s, inKey, v);
        }
        for (const other of this.accepted.get(v) ?? []) {
          if (parseKey(other).cap !== cap.id) link("co-accept", { key: other, observed: null }, inKey, v);
        }
        for (const s of this.recent.get(v)?.values() ?? []) {
          if (parseKey(s.key).cap !== cap.id) link("flow", s, inKey, v);
        }
        const acc = this.accepted.get(v) ?? [];
        if (!acc.includes(inKey)) {
          this.accepted.delete(v);
          this.accepted.set(v, [...acc, inKey]);
          if (this.accepted.size > MAX_ACCEPTED) this.accepted.delete(this.accepted.keys().next().value!);
        }
      }
    }

    // Remember what this run produced, so a later run that accepts one of these values links back here.
    // A value the call was given is echoed, not produced (a search box repeats its query).
    const given = new Set(Object.values(args).flatMap((v) => (Array.isArray(v) ? v : [v])).filter((v) => typeof v === "string"));
    for (const l of found) {
      if (given.has(l.value)) continue;
      const s = source(l);
      if (!s) continue;
      let m = this.recent.get(l.value);
      if (!m) {
        this.recent.set(l.value, (m = new Map()));
        if (this.recent.size > MAX_RECENT) this.recent.delete(this.recent.keys().next().value!);
      }
      m.set(s.key, s);
    }
    if (this.links.length !== before) {
      this.changed();
      return true;
    }
    return false;
  }

  private add(link: IdentityLink): boolean {
    if (this.links.some((l) => l.kind === link.kind && l.from === link.from && l.to === link.to)) return false;
    this.links.push(link);
    if (this.links.length > MAX_LINKS) this.links.splice(0, this.links.length - MAX_LINKS);
    return true;
  }

  /**
   * Compute schemes over the current capabilities: union-find over input ports (co-acceptance
   * and same-named siblings in one contract), then the output ports that feed each class.
   */
  private compute(caps: Iterable<Capability>) {
    if (this.classes) return this.classes;
    const byCap = new Map<string, Capability>();
    for (const c of caps) byCap.set(c.id, c);
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let r = k;
      while (parent.get(r) !== r) r = parent.get(r)!;
      parent.set(k, r);
      return r;
    };
    const touch = (k: string) => {
      if (!parent.has(k)) parent.set(k, k);
    };
    const union = (a: string, b: string) => {
      touch(a);
      touch(b);
      const ra = find(a);
      const rb = find(b);
      if (ra !== rb) parent.set(ra < rb ? rb : ra, ra < rb ? ra : rb);
    };
    const inputPort = (key: string): Port | undefined => {
      const { cap, dir, name } = parseKey(key);
      return dir === "in" ? byCap.get(cap)?.inputs.find((p) => p.name === name) : undefined;
    };
    const via: Record<string, "evidence" | "sibling"> = {};
    const values = new Map<string, Set<string>>();
    for (const l of this.links) {
      if (!inputPort(l.to)) continue;
      touch(l.to);
      via[l.to] = "evidence";
      if (!values.has(l.to)) values.set(l.to, new Set());
      values.get(l.to)!.add(l.value);
      if (l.kind === "co-accept" && inputPort(l.from)) {
        union(l.from, l.to);
        via[l.from] = "evidence";
      }
    }
    // Within one contract a qualified parameter name means one thing: every operation's
    // `accession` (or `entry_id`) of the same declared type takes the same identifiers.
    const siblings = new Map<string, string[]>();
    for (const c of byCap.values()) {
      for (const p of c.inputs) {
        if (GENERIC_NAME.test(normalize(p.name)) || p.enum || isNominal(p.name, p.type)) continue;
        const k = `${c.provider}\u0001${p.name}\u0001${p.type}`;
        const list = siblings.get(k) ?? [];
        list.push(portKey(c.id, "in", p.name));
        siblings.set(k, list);
      }
    }
    for (const group of siblings.values()) {
      const seed = group.find((k) => parent.has(k));
      if (!seed) continue;
      for (const k of group) {
        if (!parent.has(k)) via[k] = "sibling";
        union(seed, k);
      }
    }
    const members = new Map<string, string[]>();
    for (const k of parent.keys()) {
      if (!inputPort(k)) continue;
      const r = find(k);
      members.set(r, [...(members.get(r) ?? []), k]);
    }
    const outputExists = (key: string) => {
      const { cap, dir, name } = parseKey(key);
      return dir === "out" && (byCap.get(cap)?.outputs.some((p) => p.name === name) || this.observedPorts.has(key));
    };
    const feeds = new Map<string, Set<string>>();
    for (const l of this.links) {
      if (l.kind === "co-accept" || !parent.has(l.to) || !outputExists(l.from)) continue;
      const r = find(l.to);
      if (!feeds.has(r)) feeds.set(r, new Set());
      feeds.get(r)!.add(l.from);
    }
    // Stable, readable scheme ids: the class's most common input name, numbered on collision.
    const roots = [...members.keys()].sort();
    const schemes = new Map<string, SchemeInfo>();
    const inputScheme = new Map<string, string>();
    const outputSchemes = new Map<string, Set<string>>();
    const taken = new Map<string, number>();
    for (const r of roots) {
      const ms = members.get(r)!.sort();
      const names = new Map<string, number>();
      for (const m of ms) names.set(normalize(parseKey(m).name), (names.get(normalize(parseKey(m).name)) ?? 0) + 1);
      const label = [...names].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
      const n = (taken.get(label) ?? 0) + 1;
      taken.set(label, n);
      const id = n === 1 ? `scheme:${label}` : `scheme:${label}#${n}`;
      const shapes = new Set<string>();
      for (const m of ms) for (const v of values.get(m) ?? []) shapes.add(shapeOf(v));
      const fed = [...(feeds.get(r) ?? [])].sort();
      schemes.set(id, { id, members: ms, via: Object.fromEntries(ms.map((m) => [m, via[m] ?? "evidence"])), feeds: fed, shapes: [...shapes].sort() });
      for (const m of ms) inputScheme.set(m, id);
      for (const f of fed) {
        if (!outputSchemes.has(f)) outputSchemes.set(f, new Set());
        outputSchemes.get(f)!.add(id);
      }
    }
    return (this.classes = { schemes, inputScheme, outputSchemes });
  }

  schemes(caps: Iterable<Capability>): SchemeInfo[] {
    return [...this.compute(caps).schemes.values()];
  }

  /**
   * Annotate capabilities in place: input ports get their scheme, output ports the schemes
   * they feed, and observed output paths that fed a scheme become (observed) ports.
   * Idempotent: earlier annotations are replaced.
   */
  apply(caps: Iterable<Capability>): void {
    const all = [...caps];
    const { schemes, inputScheme, outputSchemes } = this.compute(all);
    for (const c of all) {
      c.outputs = c.outputs.filter((p) => !p.observed);
      for (const p of [...c.inputs, ...c.outputs]) delete p.schemes;
      for (const p of c.inputs) {
        const s = inputScheme.get(portKey(c.id, "in", p.name));
        if (s) p.schemes = [s];
      }
      for (const p of c.outputs) {
        const s = outputSchemes.get(portKey(c.id, "out", p.name));
        if (s) p.schemes = [...s].sort();
      }
    }
    // Observed paths that fed a scheme are real outputs of the operation: give the planner a port.
    for (const [key, ids] of outputSchemes) {
      const obs = this.observedPorts.get(key);
      const { cap, name } = parseKey(key);
      const c = all.find((x) => x.id === cap);
      if (!obs || !c || c.outputs.some((p) => p.name === name)) continue;
      const t = representative(all, schemes.get([...ids][0])!);
      c.outputs.push({ name, type: obs.list ? `list:${t}` : t, required: false, observed: true, schemes: [...ids].sort() });
    }
  }

  /** Schemes a caller's named value belongs to: its name is a member port's name and its shape was seen. */
  schemesFor(caps: Iterable<Capability>, name: string, value: unknown): string[] {
    if (!identifierShaped(value)) return [];
    const n = normalize(name);
    const shape = shapeOf(value);
    return this.schemes(caps)
      .filter((s) => s.shapes.includes(shape) && [...s.members, ...s.feeds].some((k) => normalize(parseKey(k).name.split(".").pop() ?? "") === n))
      .map((s) => s.id);
  }
}

/** Element type for an observed port: the most specific type the scheme's inputs declare. */
function representative(caps: Capability[], s: SchemeInfo): SemType {
  const counts = new Map<SemType, number>();
  for (const m of s.members) {
    const { cap, name } = parseKey(m);
    const t = caps.find((c) => c.id === cap)?.inputs.find((p) => p.name === name)?.type.replace(/^list:/, "");
    if (t) counts.set(t, (counts.get(t) ?? 0) + 1);
  }
  const ranked = [...counts].sort((a, b) => Number(b[0].startsWith("id.")) - Number(a[0].startsWith("id.")) || b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return ranked[0]?.[0] ?? "text";
}

/**
 * A generic (text) input that evidence placed in a scheme is known to take one kind of identifier:
 * values produced by other steps fill it only through the scheme, never as arbitrary text.
 * Ports with a specific declared type keep their typed links; caller-supplied values are not affected.
 */
export function schemeOnly(port: Port): boolean {
  return !!port.schemes?.length && /^(list:)?text$/.test(port.type);
}

/** Does a value carrying `valueSchemes` with type `valueType` fill `port` by scheme? Cardinality must match. */
export function schemeFits(port: Port, valueType: SemType, valueSchemes: string[] | undefined): boolean {
  if (!port.schemes?.length || !valueSchemes?.length) return false;
  if (isList(port.type) !== isList(valueType)) return false;
  return port.schemes.some((s) => valueSchemes.includes(s));
}
