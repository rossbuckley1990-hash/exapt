// GraphQL introspection -> typed capabilities. Every Query and Mutation field
// becomes a capability; the reflector builds the selection set itself.

import { graphqlScalar, inferInContext } from "../core/semantics.ts";
import type { Capability, DeclaredField, GraphQLFailureEvidence, Port, Reflection, SemType } from "../core/types.ts";
import { slug } from "./net.ts";

/** Introspection query with a type-reference nesting depth (servers often cap query depth). */
export function introspectionQuery(refDepth = 4): string {
  let ref = "kind name";
  for (let i = 0; i < refDepth; i++) ref = `kind name ofType { ${ref} }`;
  return `query RightClickIntrospection {
  __schema {
    queryType { name }
    mutationType { name }
    types {
      kind name description
      fields(includeDeprecated: false) {
        name description
        args { name description defaultValue type { ${ref} } }
        type { ${ref} }
      }
    }
  }
}`;
}

/** Tried in order: full depth first, then shallower for depth-limited servers. */
export const INTROSPECTION_QUERIES = [introspectionQuery(4), introspectionQuery(3), introspectionQuery(2)];
export const INTROSPECTION_QUERY = INTROSPECTION_QUERIES[0];

interface TypeRef {
  kind: string;
  name: string | null;
  ofType?: TypeRef | null;
}
interface Field {
  name: string;
  description?: string | null;
  args: Array<{ name: string; description?: string | null; defaultValue?: string | null; type: TypeRef }>;
  type: TypeRef;
}
interface FullType {
  kind: string;
  name: string;
  description?: string | null;
  fields?: Field[] | null;
}

function needsArguments(field: Field): boolean {
  return field.args.some(a => a.type.kind === "NON_NULL" && a.defaultValue == null);
}

interface SelectionSchema {
  version: 1;
  endpoint: string;
  roots: Record<string, string>;
  types: Record<string, { kind: string; fields?: Record<string, { type?: string; needsArguments?: true }> }>;
}

/** Shared per provider, not copied into every capability/signature. Missing
 * type/field lists stay unknown; a size bound never becomes a closed partial list. */
function selectionSchema(schema: any, endpoint: string): SelectionSchema | undefined {
  const types: SelectionSchema["types"] = Object.create(null);
  let count = 0;
  if (schema.types.length > 4096) return undefined;
  for (const t of schema.types as FullType[]) {
    if (t.name.startsWith("__") || !["OBJECT", "INTERFACE", "UNION", "SCALAR", "ENUM"].includes(t.kind)) continue;
    const entry: SelectionSchema["types"][string] = { kind: t.kind };
    if (Array.isArray(t.fields)) {
      const fields: NonNullable<typeof entry.fields> = Object.create(null);
      for (const f of t.fields) {
        if (++count > 65536) return undefined;
        const type = named(f.type).name;
        fields[f.name] = { ...(type ? { type } : {}),
          ...(needsArguments(f) ? { needsArguments: true as const } : {}) };
      }
      entry.fields = fields;
    }
    types[t.name] = entry;
  }
  return { version: 1, endpoint, roots: Object.fromEntries(
    [["query", schema.queryType?.name], ["mutation", schema.mutationType?.name]].filter(([, name]) => !!name)), types };
}

export function isIntrospection(doc: unknown): boolean {
  return !!(doc as any)?.data?.__schema?.types;
}

function completeRef(ref: TypeRef | null | undefined): boolean {
  let depth = 0;
  while (ref && ["NON_NULL", "LIST"].includes(ref.kind) && depth++ < 32) ref = ref.ofType;
  return !!ref && ["OBJECT", "INTERFACE", "UNION", "SCALAR", "ENUM", "INPUT_OBJECT"].includes(ref.kind) &&
    typeof ref.name === "string" && /^[_A-Za-z][_0-9A-Za-z]*$/.test(ref.name);
}

/** Fill truncated references using shallower, targeted introspection. At most
 * two additional requests, 16 observed types each; never guess a named type. */
export async function completeTypeReferences(doc: any, read: (query: string) => Promise<any>,
  observe: (ok: boolean, detail: string) => void): Promise<void> {
  const schema = doc.data.__schema;
  const roots = new Set([schema.queryType?.name, schema.mutationType?.name]);
  const types = [...schema.types as FullType[]].sort((a, b) => Number(roots.has(b.name)) - Number(roots.has(a.name)));
  const compatible = (old: TypeRef, next: TypeRef | undefined): boolean => {
    let a: TypeRef | null | undefined = old, b = next, depth = 0;
    while (a && depth++ < 32) {
      if (!b || a.kind !== b.kind || (a.name && a.name !== b.name)) return false;
      a = a.ofType; b = b.ofType ?? undefined;
    }
    return !a && completeRef(next);
  };
  for (const mode of ["outputs", "arguments"] as const) {
    const selected = types.filter(t => /^[_A-Za-z][_0-9A-Za-z]*$/.test(t.name) && t.fields?.some(f =>
      mode === "outputs" ? !completeRef(f.type) : f.args.some(a => !completeRef(a.type)))).slice(0, 16);
    if (!selected.length) continue;
    const ref = "kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }";
    const fields = mode === "outputs" ? `name type { ${ref} }` : `name args { name type { ${ref} } }`;
    const query = `query RightClickTypeReferences { ${selected.map((t, i) => `t${i}: __type(name: ${JSON.stringify(t.name)}) { name fields(includeDeprecated: false) { ${fields} } }`).join(" ")} }`;
    const response = await read(query);
    if (response?.errors?.length || !response?.data) { observe(false, `${mode}: no complete reference response`); continue; }
    let filled = 0;
    selected.forEach((type, index) => {
      const fresh = response.data[`t${index}`];
      if (fresh?.name !== type.name || !Array.isArray(fresh.fields)) return;
      for (const old of type.fields ?? []) {
        const matches = fresh.fields.filter((f: any) => f.name === old.name);
        if (matches.length !== 1) continue;
        if (mode === "outputs") {
          if (!completeRef(old.type) && compatible(old.type, matches[0].type)) { old.type = matches[0].type; filled++; }
        } else for (const arg of old.args) {
          const args = (matches[0].args ?? []).filter((a: any) => a.name === arg.name);
          if (args.length === 1 && !completeRef(arg.type) && compatible(arg.type, args[0].type)) { arg.type = args[0].type; filled++; }
        }
      }
    });
    observe(filled > 0, `${mode}: completed ${filled} references across ${selected.length} observed types`);
  }
}

function printType(t: TypeRef): string {
  if (t.kind === "NON_NULL") return `${printType(t.ofType!)}!`;
  if (t.kind === "LIST") return `[${printType(t.ofType!)}]`;
  return t.name ?? "String";
}

/** Unwrap NON_NULL/LIST. `name` is null when a depth-limited introspection truncated the chain. */
function named(t: TypeRef): { name: string | null; kind: string; list: boolean } {
  let list = false;
  let cur: TypeRef = t;
  while (cur.ofType) {
    if (cur.kind === "LIST") list = true;
    cur = cur.ofType;
  }
  if (cur.kind === "LIST") list = true;
  return { name: cur.name, kind: cur.name ? cur.kind : "UNKNOWN", list };
}

function semantic(name: string, t: TypeRef, description = "", context = ""): SemType {
  const n = named(t);
  // Another RightClick X tells us the exact semantic type.
  const tagged = /\[rightclick:([\w.:-]+)\]/.exec(description)?.[1];
  if (tagged && tagged !== "goal") return n.list && !tagged.startsWith("list:") ? `list:${tagged}` : tagged;
  const base = n.kind === "SCALAR" || n.kind === "ENUM" ? inferInContext(name, graphqlScalar(n.name!), description, context) : "json";
  return n.list ? `list:${base}` : base;
}

export function reflectGraphQL(introspection: any, endpoint: string, title?: string): Reflection {
  const schema = introspection.data.__schema;
  const types = new Map<string, FullType>(schema.types.map((t: FullType) => [t.name, t]));
  const host = new URL(endpoint).host;
  const providerTitle = title ?? `GraphQL ${host}`;
  const providerId = `graphql:${slug(host + new URL(endpoint).pathname)}`;
  const capabilities: Capability[] = [];
  const incomplete: string[] = [];

  const roots: Array<["query" | "mutation", string | undefined]> = [
    ["query", schema.queryType?.name],
    ["mutation", schema.mutationType?.name],
  ];
  for (const [operation, rootName] of roots) {
    const root = rootName ? types.get(rootName) : undefined;
    for (const field of root?.fields ?? []) {
      if (field.name.startsWith("__")) continue;
      if (!completeRef(field.type) || field.args.some(a => !completeRef(a.type))) {
        incomplete.push(`${operation}.${field.name}: incomplete type reference`);
        continue;
      }
      const inputs: Port[] = field.args.map((a) => ({
        name: a.name,
        type: semantic(a.name, a.type, a.description ?? "", field.name),
        required: a.type.kind === "NON_NULL" && a.defaultValue == null,
        description: a.description ?? undefined,
        wire: printType(a.type),
      }));
      const { selection, ports, omitted, total } = buildSelection(field, types);
      // The default selection is bounded; say what it leaves out and let the caller choose.
      const selectPort = ports.length > 1 && !field.args.some((a) => a.name === "selection") ? "selection" : undefined;
      if (selectPort) {
        const shown = omitted.length ? ` Default selects ${total - omitted.length} of ${total} fields; also available: ${clip(omitted.join(", "), 3000)}.` : "";
        inputs.push({ name: selectPort, type: "text", required: false, wire: "selection set", description: `Optional GraphQL selection set for the returned ${named(field.type).name}, e.g. "{ id name nested { field } }"; replaces the default selection.${shown}` });
      }
      const declared = declaredFields(field, types, ports);
      // Default selections are response-size bounds, not the extent of a
      // provider's contract. Expose up to 64 additional, specifically typed
      // identifier leaves for joins; execution must explicitly project them.
      const portNames = new Set(ports.map(p => p.name));
      // A long sequence of earlier list relationships must not hide a scalar
      // identifier. This matches the planner's preference for single values over
      // fan-out; it is not proof that similarly typed identifiers mean the same thing.
      const identifiers = declared.filter(f => f.type && /^(list:)?id\./.test(f.type) && !portNames.has(f.path));
      identifiers.sort((a, b) => Number(a.type!.startsWith("list:")) - Number(b.type!.startsWith("list:")));
      for (const f of identifiers.slice(0, 64)) {
        ports.push({ name: f.path, type: f.type!, required: false });
      }
      capabilities.push({
        id: `${providerId}:${operation}:${field.name}`,
        ...(declared.length ? { fields: declared } : {}),
        title: humanize(field.name) + (operation === "mutation" ? " (mutation)" : ""),
        description: (field.description ?? `${operation} ${field.name} on ${host}`).slice(0, 400),
        provider: providerId,
        source: "graphql",
        inputs,
        outputs: ports,
        risk: operation === "query" ? "read" : "write",
        tags: [operation, "graphql", host, named(field.type).name ?? ""],
        invoke: {
          kind: "graphql",
          endpoint,
          operation,
          field: field.name,
          args: Object.fromEntries(field.args.map((a) => [a.name, printType(a.type)])),
          selection,
          ...(selectPort ? { selectPort } : {}),
        },
      });
    }
  }

  return {
    provider: {
      id: providerId,
      title: providerTitle,
      source: "graphql",
      origin: endpoint,
      learnedAt: new Date().toISOString(),
      capabilityIds: capabilities.map((c) => c.id),
      meta: { graphqlSelection: selectionSchema(schema, endpoint), ...(incomplete.length ? { graphqlIncomplete: incomplete } : {}) },
    },
    capabilities,
  };
}

function buildSelection(field: Field, types: Map<string, FullType>): { selection: string; ports: Port[]; omitted: string[]; total: number } {
  const ret = named(field.type);
  const wrap = (t: SemType) => (ret.list ? `list:${t}` : t);
  const target = ret.name ? types.get(ret.name) : undefined;
  if (!target || target.kind === "SCALAR" || target.kind === "ENUM") {
    return { selection: "", ports: [{ name: "", type: semantic(field.name, field.type), required: true }], omitted: [], total: 0 };
  }
  const ports: Port[] = [{ name: "", type: ret.list ? "list:json" : "json", required: true }];
  const parts: string[] = [];
  const selectable = (target.fields ?? []).filter((f) => !needsArguments(f));
  // Fields beyond the default selection, with their scalar subfields, so a caller can ask for them.
  const omitted = selectable.slice(25).map((f) => {
    const ft = named(f.type).name ? types.get(named(f.type).name!) : undefined;
    if (!ft || ft.kind !== "OBJECT") return f.name;
    const subs = (ft.fields ?? []).filter((x) => !needsArguments(x) && ["SCALAR", "ENUM"].includes(types.get(named(x.type).name ?? "")?.kind ?? "")).map((x) => x.name);
    return subs.length ? `${f.name} { ${subs.slice(0, 8).join(" ")}${subs.length > 8 ? " …" : ""} }` : `${f.name} { … }`;
  });
  for (const f of selectable.slice(0, 25)) {
    const n = named(f.type);
    if (!n.name) continue; // truncated type: can't build a valid selection
    const ft = types.get(n.name);
    if (!ft || ft.kind === "SCALAR" || ft.kind === "ENUM") {
      parts.push(f.name);
      ports.push({ name: f.name, type: wrap(semantic(f.name, f.type, f.description ?? "", target.name)), required: true });
    } else if (ft.kind === "OBJECT") {
      const subs = (ft.fields ?? [])
        .filter((s) => {
          const sn = named(s.type).name;
          return !needsArguments(s) && !!sn && ["SCALAR", "ENUM"].includes(types.get(sn)?.kind ?? "SCALAR");
        })
        .slice(0, 8);
      if (!subs.length) continue;
      parts.push(`${f.name} { ${subs.map((s) => s.name).join(" ")} }`);
      for (const s of subs) {
        const st = semantic(s.name, s.type, s.description ?? "", ft.name);
        const listy = ret.list || n.list;
        ports.push({ name: `${f.name}.${s.name}`, type: listy && !st.startsWith("list:") ? `list:${st}` : st, required: true });
      }
    }
  }
  return { selection: parts.length ? `{ ${parts.join(" ")} }` : "{ __typename }", ports, omitted, total: selectable.length };
}

/**
 * Every field the return type declares, three levels deep (lists included), each marked with
 * whether the default selection asks for it. Fields that need arguments are not selectable.
 */
function declaredFields(field: Field, types: Map<string, FullType>, ports: Port[]): DeclaredField[] {
  const selected = new Set(ports.map((p) => p.name).filter(Boolean));
  const out: DeclaredField[] = [];
  // Breadth-first: every top-level field before any nested detail, so a bound never hides a
  // shallow summary field behind the depths of earlier fields (rcsb_entry_info.resolution_combined).
  let level: Array<{ typeName: string | null | undefined; prefix: string; seen: Set<string>; lists: number }> = [{ typeName: named(field.type).name, prefix: "", seen: new Set(), lists: named(field.type).list ? 1 : 0 }];
  for (let depth = 1; depth <= 3 && level.length && out.length < 1500; depth++) {
    const next: typeof level = [];
    for (const { typeName, prefix, seen, lists } of level) {
      const t = typeName ? types.get(typeName) : undefined;
      if (!t || t.kind !== "OBJECT" || seen.has(t.name!)) continue;
      for (const f of t.fields ?? []) {
        if (needsArguments(f)) continue;
        const path = prefix ? `${prefix}.${f.name}` : f.name;
        if (out.length >= 1500) break;
        const n = named(f.type), ft = n.name ? types.get(n.name) : undefined;
        const type = ft && ["SCALAR", "ENUM"].includes(ft.kind) ? "list:".repeat(lists) + semantic(f.name, f.type, f.description ?? "", t.name) : undefined;
        out.push({ path, selected: selected.has(path), ...(type ? { type } : {}) });
        next.push({ typeName: n.name, prefix: path, seen: new Set([...seen, t.name!]), lists: lists + (n.list ? 1 : 0) });
      }
    }
    level = next;
  }
  return out;
}

/** A selection set: the default one plus the given field paths (merged as a tree). */
export function selectionWith(defaultSelection: string, paths: string[]): string {
  type Tree = Map<string, Tree>;
  const root: Tree = new Map();
  const add = (parts: string[]) => {
    let t = root;
    for (const p of parts) {
      if (!t.has(p)) t.set(p, new Map());
      t = t.get(p)!;
    }
  };
  // Parse the default selection into the tree.
  const tokens = defaultSelection.match(/[A-Za-z_][\w]*|[{}]/g) ?? [];
  const stack: string[] = [];
  let last = "";
  for (const tok of tokens) {
    if (tok === "{") {
      if (last) stack.push(last);
      last = "";
    } else if (tok === "}") {
      stack.pop();
      last = "";
    } else {
      add([...stack, tok]);
      last = tok;
    }
  }
  for (const p of paths) add(p.split("."));
  const print = (t: Tree): string => [...t].map(([k, sub]) => (sub.size ? `${k} { ${print(sub)} }` : k)).join(" ");
  return `{ ${print(root)} }`;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, s.lastIndexOf(",", n))}, … (truncated)`;
}

function humanize(s: string): string {
  const t = s.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/([A-Z])([A-Z][a-z])/g, "$1 $2").replace(/_/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Terminal for this request, never an invitation to replan or replay effects. */
export class GraphQLFailure extends Error {
  readonly evidence: GraphQLFailureEvidence;
  constructor(evidence: GraphQLFailureEvidence) { super(evidence.reason); this.evidence = evidence; }
}

/** Local document mistakes are not evidence of provider drift. */
export class GraphQLDocumentError extends GraphQLFailure {
  constructor(reason: string) { super({ kind: "invalid-document", reason, runs: [] }); }
}

interface SelectionField { name: string; responseName: string; children: SelectionField[] }

/** One bounded selection subtree. Aliases are allowed; arguments, directives,
 * fragments and additional root fields outside this subtree are not. */
export function checkSelection(sel: unknown): string {
  parseSelection(sel);
  return (sel as string).trim();
}

function parseSelection(sel: unknown): SelectionField[] {
  const fail = (): never => { throw new GraphQLDocumentError(`selection must be a GraphQL selection set such as "{ id name nested { field } }" (one nonempty subtree; no arguments, variables, fragments or operations; at most 64 levels, 4096 fields and 65536 characters)`); };
  if (typeof sel !== "string" || sel.length > 65536) return fail();
  const s = sel.trim(), tokens = s.match(/[_A-Za-z][_0-9A-Za-z]*|[{}:]|[^\s,]/g) ?? [];
  const name = /^[_A-Za-z][_0-9A-Za-z]*$/;
  let at = 0, fields = 0;
  const block = (depth: number): SelectionField[] => {
    if (depth > 64 || tokens[at++] !== "{") fail();
    const out: SelectionField[] = [];
    while (at < tokens.length && tokens[at] !== "}") {
      const responseName = tokens[at++];
      if (++fields > 4096 || !name.test(responseName ?? "")) fail();
      let fieldName = responseName;
      if (tokens[at] === ":") { at++; fieldName = tokens[at++]; if (!name.test(fieldName ?? "")) fail(); }
      out.push({ name: fieldName, responseName, children: tokens[at] === "{" ? block(depth + 1) : [] });
    }
    if (!out.length || tokens[at++] !== "}") fail();
    return out;
  };
  const out = block(1);
  if (at !== tokens.length) fail();
  return out;
}

/** Validate only what retained introspection establishes. In particular, the
 * bounded output-port/declared-field projection is not a complete schema. */
export function validateSelection(inv: { endpoint: string; operation: string; field: string; selection: string }, evidence: unknown): void {
  const schema = evidence as SelectionSchema | undefined;
  if (!schema || schema.version !== 1 || schema.endpoint !== inv.endpoint || !schema.types || !schema.roots) return;
  const own = <T>(map: Record<string, T> | undefined, key: string): T | undefined => map && Object.hasOwn(map, key) ? map[key] : undefined;
  const root = own(schema.types, own(schema.roots, inv.operation) ?? "");
  const returned = own(root?.fields, inv.field)?.type;
  if (!returned) return;
  const fail = (reason: string): never => { throw new GraphQLDocumentError(`GraphQL selection: ${reason}; refresh the contract explicitly if the provider changed`); };
  const walk = (typeName: string, fields: SelectionField[], path: string) => {
    const type = own(schema.types, typeName);
    if (!type) return; // incomplete/truncated introspection is not negative evidence
    if (["SCALAR", "ENUM"].includes(type.kind)) {
      if (fields.length) fail(`${path} is a leaf of type ${typeName} and cannot have subfields`);
      return;
    }
    if (!["OBJECT", "INTERFACE", "UNION"].includes(type.kind)) return;
    if (!fields.length) fail(`${path} of type ${typeName} requires subfields`);
    const responses = new Map<string, string>();
    for (const field of fields) {
      const prior = responses.get(field.responseName);
      if (prior && prior !== field.name) fail(`${path}.${field.responseName} aliases conflicting fields`);
      responses.set(field.responseName, field.name);
      if (field.name === "__typename") {
        if (field.children.length) fail(`${path}.__typename is a leaf`);
        continue;
      }
      const def = own(type.fields, field.name);
      if (!def) {
        if (type.fields || type.kind === "UNION") fail(`${path}.${field.name} is not declared on learned type ${typeName}`);
        continue;
      }
      if (def.needsArguments) fail(`${path}.${field.name} requires arguments outside the supported selection vocabulary`);
      if (def.type) walk(def.type, field.children, `${path}.${field.name}`);
    }
  };
  walk(returned, inv.selection ? parseSelection(inv.selection) : [], inv.field);
}

export function buildDocument(inv: { operation: string; field: string; args: Record<string, string>; selection: string }, provided: string[]): string {
  const name = /^[_A-Za-z][_0-9A-Za-z]*$/;
  const type = (value: string): boolean => {
    if (typeof value !== "string" || value.length > 256) return false;
    // Printed introspection types have no whitespace and at most one NON_NULL
    // suffix per named/list type. Validate the nesting, not just its alphabet.
    const tokens = value.match(/[_A-Za-z][_0-9A-Za-z]*|./g) ?? [];
    let at = 0;
    const parse = (depth: number): boolean => {
      if (depth > 32) return false;
      if (tokens[at] === "[") { at++; if (!parse(depth + 1) || tokens[at++] !== "]") return false; }
      else if (!name.test(tokens[at++] ?? "")) return false;
      if (tokens[at] === "!") at++;
      return true;
    };
    return parse(0) && at === tokens.length;
  };
  if (!["query", "mutation"].includes(inv.operation) || !name.test(inv.field) ||
      Object.entries(inv.args).some(([n, t]) => !name.test(n) || !type(t)))
    throw new GraphQLDocumentError("invalid GraphQL operation, field, argument name or type");
  const selection = inv.selection ? checkSelection(inv.selection) : "";
  // The runtime checks required inputs before execution. An omitted argument
  // may have a provider default even when its wire type is NON_NULL; declaring
  // an absent required variable would incorrectly override that default.
  const used = Object.entries(inv.args).filter(([n]) => provided.includes(n));
  const vars = used.map(([n, t]) => `$${n}: ${t}`).join(", ");
  const call = used.map(([n]) => `${n}: $${n}`).join(", ");
  return `${inv.operation} RightClick${vars ? `(${vars})` : ""} { ${inv.field}${call ? `(${call})` : ""} ${selection} }`;
}
