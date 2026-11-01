// Output views: what an AI client receives of a run's output.
//
// A capability can return megabytes. The run record, the receipt digest and
// every stored check keep the whole output; the view only decides what goes
// back over the tool interface. Without a view, an output over the response
// budget is never silently cut: it is replaced by an explicit summary (size,
// top-level shape, count) that says how to ask for a count, a projection, a
// slice, or the full output.

import { pick } from "./verify.ts";

export interface OutputView {
  /** Path into the output (verify path syntax: "a.b", "0.c", or "items.id" to map over an array). */
  select?: string;
  /** Project each element (or the object) onto these paths. Keys are the paths. */
  fields?: string[];
  /** Return the number of elements (array), keys (object) or characters (string) instead of the value. */
  count?: boolean;
  /** Slice of the selected array, string or object entries. */
  offset?: number;
  limit?: number;
  /** Return the selected value whole, even over the response budget. */
  full?: boolean;
}

/** Characters of compact JSON an output may occupy in a tool response before it is summarised. */
export const OUTPUT_BUDGET = 32_000;

export interface ViewReport {
  /** The view that was applied, as given. */
  view?: OutputView;
  /** Characters of compact JSON in the full recorded output. */
  chars: number;
  /** Elements, keys or characters of the selected value before any slice. */
  total?: number;
  /** The select path did not exist in the output. */
  found?: false;
  /** The value was withheld because it exceeded the budget; ask again with a view. */
  omitted?: true;
  reason?: string;
  /** Shape of the selected value, when it was omitted or the path was not found. */
  shape?: unknown;
  hint?: string;
}

const VIEW_KEYS = new Set(["select", "fields", "count", "offset", "limit", "full"]);

export function parseView(v: unknown): OutputView | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "object" || Array.isArray(v)) throw new Error("view must be an object");
  const o = v as Record<string, unknown>;
  for (const k of Object.keys(o)) if (!VIEW_KEYS.has(k)) throw new Error(`unknown view option: ${k}`);
  if (o.select !== undefined && typeof o.select !== "string") throw new Error("view.select must be a path string");
  if (o.fields !== undefined && (!Array.isArray(o.fields) || o.fields.some((f) => typeof f !== "string"))) throw new Error("view.fields must be an array of path strings");
  for (const k of ["offset", "limit"] as const) if (o[k] !== undefined && (!Number.isInteger(o[k]) || (o[k] as number) < 0)) throw new Error(`view.${k} must be a non-negative integer`);
  for (const k of ["count", "full"] as const) if (o[k] !== undefined && typeof o[k] !== "boolean") throw new Error(`view.${k} must be a boolean`);
  return o as OutputView;
}

const size = (v: unknown): number => (v === undefined ? 0 : JSON.stringify(v)?.length ?? 0);

function total(v: unknown): number | undefined {
  if (Array.isArray(v) || typeof v === "string") return v.length;
  if (v && typeof v === "object") return Object.keys(v).length;
  return undefined;
}

/** A compact type outline: keys and element types, array lengths, never values. */
export function shape(v: unknown, depth = 3): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return { array: 0 };
    if (depth <= 0) return { array: v.length };
    const sample = v.slice(0, 200);
    const objects = sample.filter((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<string, unknown>[];
    if (objects.length === sample.length) {
      // Union of keys across elements, so optional fields are visible too.
      const merged: Record<string, unknown> = {};
      for (const o of objects) for (const [k, x] of Object.entries(o)) if (!(k in merged) || merged[k] == null) merged[k] = x;
      return { array: v.length, of: shape(merged, depth - 1) };
    }
    return { array: v.length, of: [...new Set(sample.map((x) => JSON.stringify(shape(x, depth - 1))))].map((s) => JSON.parse(s)) };
  }
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (depth <= 0) return { object: entries.length };
    const out: Record<string, unknown> = {};
    for (const [k, x] of entries.slice(0, 40)) out[k] = shape(x, depth - 1);
    if (entries.length > 40) out["…"] = `${entries.length - 40} more keys`;
    return out;
  }
  if (typeof v === "string") return v.length > 80 ? `string(${v.length})` : "string";
  return typeof v;
}

function slice(v: unknown, offset = 0, limit?: number): unknown {
  const end = limit === undefined ? undefined : offset + limit;
  if (Array.isArray(v) || typeof v === "string") return v.slice(offset, end);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).slice(offset, end));
  return v;
}

function project(v: unknown, fields: string[]): unknown {
  const one = (x: unknown) => Object.fromEntries(fields.map((f) => [f, pick(x, f)]));
  return Array.isArray(v) ? v.map(one) : one(v);
}

/**
 * Apply a view to a recorded output. `again` names how to ask for this output
 * again with a view (e.g. without re-running the capability).
 */
export function applyView(output: unknown, view: OutputView | undefined, again: string, budget = OUTPUT_BUDGET): { value: unknown; report?: ViewReport } {
  const chars = size(output);
  if (!view && chars <= budget) return { value: output };
  const report: ViewReport = { ...(view ? { view } : {}), chars };
  let value = output;
  if (view?.select) {
    value = pick(output, view.select);
    if (value === undefined) return { value: null, report: { ...report, found: false, shape: shape(output), hint: "The select path is not in this output; paths follow the shape shown." } };
  }
  const t = total(value);
  if (t !== undefined) report.total = t;
  if (view?.count) {
    if (t === undefined) return { value: null, report: { ...report, shape: shape(value), hint: "count applies to arrays, objects and strings." } };
    return { value: t, report };
  }
  if (view?.offset !== undefined || view?.limit !== undefined) value = slice(value, view.offset, view.limit);
  if (view?.fields?.length) value = project(value, view.fields);
  const returned = size(value);
  if (!view?.full && returned > budget) {
    return {
      value: undefined,
      report: {
        ...report,
        omitted: true,
        reason: `${view ? "the viewed output" : "the output"} is ${returned} characters of JSON, over the ${budget}-character response budget; nothing was cut, it was withheld whole`,
        shape: shape(value),
        hint: `Ask for less with view: {"count":true}, {"select":"<path>"}, {"fields":["<path>",…]}, {"offset":0,"limit":10}; or {"full":true} for all of it. ${again}`,
      },
    };
  }
  return { value, report };
}
