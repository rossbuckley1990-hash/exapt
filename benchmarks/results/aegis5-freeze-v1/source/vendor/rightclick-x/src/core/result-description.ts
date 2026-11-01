// Advisory retained result declarations. Never inputs to planning or authority.
import { signature, type CapabilityGraph } from "./graph.ts";
import type { PlanStep } from "./types.ts";

export interface ResultDescription {
  type: string;
  root: { capability: string; path: string };
  references: Array<{ capability: string; signature: string }>;
  fields: Array<{ path: string; selected?: boolean }>;
  truncated: boolean;
}

/** Follow the result reference only, including nested retained composites.
 * Capture declarations, never output values, caller constants or inferred keys. */
export function describeResult(graph: CapabilityGraph, steps: PlanStep[], result: string, type: string): ResultDescription | undefined {
  const [index, ...rest] = result.split(".");
  const root = { capability: steps[Number(index)]?.capability, path: rest.join(".") };
  if (!root.capability) return;
  let cap = graph.get(root.capability), path = root.path;
  const references: ResultDescription["references"] = [];
  while (cap) {
    if (references.length >= 8 || references.some(r => r.capability === cap!.id)) return;
    references.push({ capability: cap.id, signature: signature(cap) });
    if (cap.invoke.kind !== "composite") break;
    const [step, ...inner] = cap.invoke.result.split(".");
    path = [...inner, ...(path ? [path] : [])].join(".");
    cap = graph.get(cap.invoke.steps[Number(step)]?.capability);
  }
  if (!cap || cap.invoke.kind === "goal") return;
  const prefix = path ? `${path}.` : "", seen = new Set<string>();
  const fields: ResultDescription["fields"] = [];
  let truncated = false, chars = 0;
  const declared = [...cap.fields ?? [], ...cap.outputs.filter(p => p.name && !p.observed).map(p => ({ path: p.name, selected: true }))];
  for (const field of declared) {
    const absolute = field.path.replace(/\[\]/g, "");
    if (prefix && !absolute.startsWith(prefix)) continue;
    const relative = prefix ? absolute.slice(prefix.length) : absolute;
    if (!relative || seen.has(relative)) continue;
    seen.add(relative);
    const next = { path: relative, ...(field.selected === undefined ? {} : { selected: field.selected }) };
    const size = JSON.stringify(next).length;
    if (fields.length >= 64 || chars + size > 4096) { truncated = true; continue; }
    fields.push(next); chars += size;
  }
  const description = { type, root, references, fields, truncated };
  return JSON.stringify(description).length <= 8192 ? description : undefined;
}

export function resultDescription(graph: CapabilityGraph, saved: ResultDescription | undefined) {
  const note = "Declarations from the last successful plan, not observed values or a future output guarantee. Comparison does not cover omitted fields. Matching declarations do not establish authority, semantic equivalence or current execution success.";
  if (!saved) return { status: "not-recorded", note };
  // Persisted advisory metadata may come from a different/older writer. Unknown
  // shapes remain unassessed; they must not break execution or become authority.
  if (!saved.root || typeof saved.root.capability !== "string" || typeof saved.root.path !== "string" ||
      typeof saved.type !== "string" || typeof saved.truncated !== "boolean" ||
      !Array.isArray(saved.references) || saved.references.length > 8 || !Array.isArray(saved.fields) || saved.fields.length > 64 ||
      Object.keys(saved).some(k => !["type", "root", "references", "fields", "truncated"].includes(k)) ||
      saved.references.some(r => !r || typeof r.capability !== "string" || typeof r.signature !== "string") ||
      saved.fields.some(f => !f || typeof f.path !== "string" || (f.selected !== undefined && typeof f.selected !== "boolean")) ||
      JSON.stringify(saved).length > 8192)
    return { status: "not-recorded", note };
  const current = describeResult(graph, [{ capability: saved.root.capability, bindings: [] }],
    `0${saved.root.path ? `.${saved.root.path}` : ""}`, saved.type);
  return { ...saved, status: !current ? "unavailable-result-declaration" : JSON.stringify(current) === JSON.stringify(saved)
    ? (saved.truncated ? "matches-retained-result-subset" : "matches-current-result-declaration") : "changed-result-declaration", note };
}
