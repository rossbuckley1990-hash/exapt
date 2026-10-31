// Goal satisfaction (experiments/goal-satisfaction/PREREGISTRATION.md).
//
// Type compatibility is not satisfaction: with `want: json`, every lookup "answers". A plan is
// judged on what its RESULT carries for each piece of required information (`require`), and on
// how each of its joins is supported:
//   caller   - the caller's own value;
//   evidence - a learned identifier scheme (values observed to link the two ports);
//   declared - a specific declared type on both sides (not text/json/number plumbing);
//   generic  - text/json/number/id plumbing that any value would satisfy.
// Statuses: established (all required information in the result's declared fields, no generic
// join), unverified (information present, but a join is generic), incomplete (missing).
// Plan length and fan-out earn nothing by themselves.
import type { CapabilityGraph } from "./graph.ts";
import { tokenize } from "./graph.ts";
import { validLinkBinding } from "./links.ts";
import type { Capability, DeclaredField, PlanStep } from "./types.ts";

export type JoinKind = "caller" | "evidence" | "declared" | "contract" | "generic";
export type SatisfactionStatus = "established" | "unverified" | "incomplete";

export interface Satisfaction {
  status: SatisfactionStatus;
  /** required term -> the declared result field that carries it */
  covered: Record<string, string>;
  missing: string[];
  joins: Array<{ step: number; port: string; from: string; kind: JoinKind }>;
  /** GraphQL steps whose required fields are declared but not in the default selection. */
  projection: Array<{ step: number; fields: string[] }>;
}

const GENERIC = new Set(["text", "json", "number", "id", "boolean", "list:text", "list:json", "list:number", "list:id"]);

/** The fields a step's result carries under a result path, from ports and contract-declared fields. */
export function resultFields(cap: Capability, path: string): DeclaredField[] {
  const prefix = path ? `${path}.` : "";
  // A declared field's own flag wins: an output port observed under some custom request is not
  // something the default request returns (Q03: an EM-only field seen once was taken as selected).
  const declared = cap.fields ?? [];
  const declaredPaths = new Set(declared.map((f) => f.path.replace(/\[\]/g, "")));
  const fromPorts = cap.outputs.filter((o) => o.name && !declaredPaths.has(o.name)).map((o) => ({ path: o.name, selected: !o.observed }) as DeclaredField);
  const all = [...declared, ...fromPorts];
  const seen = new Set<string>();
  const out: DeclaredField[] = [];
  for (const f of all) {
    const p = f.path.replace(/\[\]/g, "");
    if (prefix && !p.startsWith(prefix)) continue;
    const rel = prefix ? p.slice(prefix.length) : p;
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push({ path: rel, selected: f.selected });
  }
  // A leaf result (e.g. "2.rate") carries its own name.
  if (path && !out.length) out.push({ path: path.split(".").pop()!, selected: true });
  return out;
}

/** Does a field path carry a required term? Every word of the term must appear in the path. */
export function carries(path: string, term: string): boolean {
  const want = tokenize(term);
  const have = new Set(tokenize(path.replace(/[._\[\]]+/g, " ")));
  return want.length > 0 && want.every((w) => have.has(w));
}

/** Terms no current result could carry. This is only a necessary condition for
 * satisfaction, not evidence of a usable plan. Include unselected and blocked
 * capabilities: projection or policy diagnosis still needs the normal search.
 * Result paths only remove prefixes from declared fields; leaf results can
 * also use a literal port name. Recompute after discovery: absence is local
 * to the snapshot, not a claim about undiscovered providers. */
export function undeclaredRequirements(graph: CapabilityGraph, require: string[]): string[] {
  if (!require.length) return [];
  let missing = [...require];
  for (const cap of graph.capabilities.values()) {
    // Keep raw names too: resultFields normalises [] in declarations, but its
    // leaf fallback retains literal brackets (e.g. a key named parcel[]mass).
    const fields = [...resultFields(cap, ""), ...cap.outputs.map(p => ({ path: p.name }))];
    missing = missing.filter(term => !fields.some(f => carries(f.path, term)));
    if (!missing.length) break;
  }
  return missing;
}

export function assess(graph: CapabilityGraph, steps: PlanStep[], result: string, require: string[], have: Record<string, string> = {}, haveSchemes: Record<string, string[]> = {}): Satisfaction {
  const covered: Record<string, string> = {};
  const projection: Satisfaction["projection"] = [];
  const last = steps.length - 1;
  const [stepIdx, ...rest] = result.split(".");
  const resultStep = Number(stepIdx);
  const cap = graph.get(steps[resultStep]?.capability ?? "");
  if (cap) {
    const fields = resultFields(cap, rest.join("."));
    const needProjection: string[] = [];
    const projectable = cap.invoke.kind === "graphql" && !!(cap.invoke as any).selectPort;
    for (const term of require) {
      const sel = fields.find((f) => f.selected !== false && carries(f.path, term));
      const unselected = fields.filter((f) => f.selected === false && carries(f.path, term));
      const any = sel ?? unselected[0];
      if (!any) continue;
      // Declared but unreachable (the provider cannot be asked for it): not covered.
      if (!sel && !projectable) continue;
      covered[term] = any.path;
      // Ask for every declared field that carries the term (bounded): which one has a value can
      // depend on the record (an EM-only field is empty for an X-ray entry).
      // Shallow fields first: a summary field (rcsb_entry_info.resolution_combined) before deep specifics.
      if (projectable) needProjection.push(...[...unselected].sort((a, b) => a.path.split(".").length - b.path.split(".").length || a.path.length - b.path.length).slice(0, 24).map((f) => f.path));
      // (also when a selected field carries the term: it may be empty for this record)
    }
    if (needProjection.length) projection.push({ step: resultStep, fields: needProjection });
  }
  void last;
  const missing = require.filter((t) => !(t in covered));

  const joins: Satisfaction["joins"] = [];
  steps.forEach((st, i) => {
    const c = graph.get(st.capability);
    for (const b of st.bindings) {
      if (b.value !== undefined) continue;
      const port = c?.inputs.find((p) => p.name === b.port);
      let kind: JoinKind;
      if (b.from.startsWith("$in.")) {
        // The caller's own value is a trusted join only where it fits the port: the same name, the
        // same specific type, or a learned scheme. An accession poured into an ontology-name port
        // (or a gene symbol into an accession port) is plumbing, not a caller join.
        const name = b.from.slice(4).split(".")[0];
        const t = have[name] ?? "json";
        const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
        const sameName = !!port && norm(port.name) === norm(name);
        const sameType = !!port && !GENERIC.has(port.type) && port.type.replace(/^list:/, "") === t.replace(/^list:/, "");
        const scheme = !!port?.schemes?.some((sc) => haveSchemes[name]?.includes(sc));
        kind = sameName || sameType || scheme ? "caller" : "generic";
      } else {
        const [si, ...pp] = b.from.split(".");
        const src = graph.get(steps[Number(si)]?.capability ?? "");
        const out = src?.outputs.find((o) => o.name === pp.join("."));
        // A downstream join needs its producer's declared field just as a final
        // outcome does. Merely exposing a typed port must not imply it is in the
        // default GraphQL response.
        const field = src?.fields?.find(f => f.path === pp.join("."));
        if (field?.selected === false && src?.invoke.kind === "graphql" && src.invoke.selectPort) {
          const existing = projection.find(p => p.step === Number(si));
          if (existing) { if (!existing.fields.includes(field.path)) existing.fields.push(field.path); }
          else projection.push({ step: Number(si), fields: [field.path] });
        }
        const outType = out?.type.replace(/^list:/, "") ?? "json";
        const portType = port?.type.replace(/^list:/, "") ?? "json";
        if (b.link && validLinkBinding(src, c, b)) kind = "contract";
        else if (port?.schemes?.length && out?.schemes?.some((s) => port.schemes!.includes(s))) kind = "evidence";
        else if (port && !GENERIC.has(port.type) && !GENERIC.has(portType) && (outType === portType || (portType.startsWith("id.") && outType === portType))) kind = "declared";
        else kind = "generic";
      }
      joins.push({ step: i, port: b.port, from: b.from, kind });
    }
  });
  const status: SatisfactionStatus = missing.length ? "incomplete" : joins.some((j) => j.kind === "generic") ? "unverified" : "established";
  return { status, covered, missing, joins, projection };
}

export const STATUS_RANK: Record<SatisfactionStatus, number> = { established: 2, unverified: 1, incomplete: 0 };

/** After a run: does the actual output carry every required term (a key path with a value)? */
export function outputCarries(output: unknown, require: string[]): { present: string[]; absent: string[] } {
  const paths: string[] = [];
  const walk = (v: unknown, prefix: string, depth: number) => {
    if (depth > 8 || paths.length > 20000) return;
    if (Array.isArray(v)) {
      for (const x of v.slice(0, 200)) walk(x, prefix, depth + 1);
    } else if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        const p = prefix ? `${prefix}.${k}` : k;
        if (x !== null && x !== undefined && x !== "") paths.push(p);
        walk(x, p, depth + 1);
      }
    }
  };
  walk(output, "", 0);
  const present = require.filter((t) => paths.some((p) => carries(p, t)));
  return { present, absent: require.filter((t) => !present.includes(t)) };
}
