// The GraphQL face of an instance. Every published goal becomes a Query field,
// so whatever the instance learned (an MCP server, a REST API, a GraphQL API,
// a chain across all three) is queryable by any GraphQL client. Semantic
// types travel in descriptions ("[rightclick:place]") so another RightClick X
// reflects them exactly.
//
// Supported: introspection, and queries selecting one published goal with
// arguments given as variables or literals. Not supported: mutations,
// fragments, aliases, multiple root fields.

import { goalParams, type RightClick } from "../runtime.ts";

const named = (kind: string, name: string) => ({ kind, name, ofType: null });
const nonNull = (t: unknown) => ({ kind: "NON_NULL", name: null, ofType: t });
const list = (t: unknown) => ({ kind: "LIST", name: null, ofType: t });

function camel(slug: string): string {
  return slug.replace(/-([a-z0-9])/g, (_, c) => c.toUpperCase());
}
function pascal(slug: string): string {
  const c = camel(slug);
  return c.charAt(0).toUpperCase() + c.slice(1);
}
function scalarFor(t: string): string {
  if (t === "number" || t.startsWith("geo.") || t.startsWith("quantity:")) return "Float";
  if (t === "boolean") return "Boolean";
  if (t === "json" || t.startsWith("list:")) return "JSON";
  return "String";
}
function field(name: string, description: string, type: unknown, args: unknown[] = []) {
  return { name, description, args, type, isDeprecated: false, deprecationReason: null };
}

export function introspection(rc: RightClick) {
  const goals = [...rc.published.values()];
  const types: any[] = [
    {
      kind: "OBJECT",
      name: "Query",
      description: `Published goals of ${rc.name}. Each field is re-derived from a live, self-maintaining capability graph.`,
      fields: goals.map((g) =>
        field(
          camel(g.slug),
          `${g.title}. Synthesized by RightClick X (${(g.lastPipeline ?? []).join(" → ")}). [rightclick:goal]`,
          named("OBJECT", `${pascal(g.slug)}Result`),
          goalParams(g).map(([n, t]) => ({ name: n, description: `[rightclick:${t}]`, type: nonNull(named("SCALAR", scalarFor(t))), defaultValue: null })),
        ),
      ),
      inputFields: null,
      interfaces: [],
      enumValues: null,
      possibleTypes: null,
    },
    ...goals.map((g) => ({
      kind: "OBJECT",
      name: `${pascal(g.slug)}Result`,
      description: `Result of ${g.title}`,
      fields: [
        field("result", `[rightclick:${g.want}]`, named("SCALAR", scalarFor(g.want))),
        field("ok", "", named("SCALAR", "Boolean")),
        field("status", "completed, pending or failed", named("SCALAR", "String")),
        field("pending", "Unresolved accepted work; not a completed outcome", named("SCALAR", "JSON")),
        field("refusal", "Execution boundary refusal; no repair or substitute execution", named("SCALAR", "JSON")),
        field("planningRefusal", "Local planning restrictions; independent authority is not assessed", named("SCALAR", "JSON")),
        field("graphqlFailure", "Invalid GraphQL request or execution errors; no automatic replay", named("SCALAR", "JSON")),
        field("verification", "", named("SCALAR", "String")),
        field("witnesses", "Independent outcome-check evidence", named("SCALAR", "JSON")),
        field("pipeline", "", list(named("SCALAR", "String"))),
        field("receipt", "Head of the receipt hash chain", named("SCALAR", "String")),
      ],
      inputFields: null,
      interfaces: [],
      enumValues: null,
      possibleTypes: null,
    })),
    ...["String", "Float", "Boolean", "JSON", "ID", "Int"].map((n) => ({ kind: "SCALAR", name: n, description: n === "JSON" ? "Any JSON value" : null, fields: null, inputFields: null, interfaces: null, enumValues: null, possibleTypes: null })),
  ];
  return {
    data: {
      __schema: { queryType: { name: "Query" }, mutationType: null, subscriptionType: null, types, directives: [] },
    },
  };
}

/** Parse `[query [Name][(vars)]] { field(arg: $v | "lit" | 1 | true) { a b } }`. */
export function parseQuery(query: string, variables: Record<string, unknown> = {}) {
  const body = query.replace(/#[^\n]*/g, "");
  const m = /\{\s*(\w+)\s*(?:\(([^)]*)\))?\s*(?:\{([^}]*)\})?\s*\}\s*$/.exec(body.trim());
  if (!m) throw new Error("unsupported query shape: select exactly one published goal");
  const args: Record<string, unknown> = {};
  for (const a of (m[2] ?? "").matchAll(/(\w+)\s*:\s*("(?:[^"\\]|\\.)*"|\$\w+|-?\d+(?:\.\d+)?|true|false|null)/g)) {
    const raw = a[2];
    args[a[1]] = raw.startsWith("$") ? variables[raw.slice(1)] : raw.startsWith('"') ? JSON.parse(raw) : raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : Number(raw);
  }
  const selection = (m[3] ?? "result").split(/[\s,]+/).filter(Boolean);
  return { field: m[1], args, selection };
}

export async function executeGraphQL(rc: RightClick, body: { query?: string; variables?: Record<string, unknown> }) {
  const query = body.query ?? "";
  if (/__schema|__type\b/.test(query)) return introspection(rc);
  try {
    const { field, args, selection } = parseQuery(query, body.variables ?? {});
    const goal = [...rc.published.values()].find((g) => camel(g.slug) === field);
    if (!goal) return { data: null, errors: [{ message: `Cannot query field "${field}" on type "Query".` }] };
    const out = await rc.callPublished(goal.slug, args);
    const full: Record<string, unknown> = { result: out.result, ok: out.ok, status: out.status, pending: out.pending, refusal: out.refusal, planningRefusal: out.planningRefusal, graphqlFailure: out.graphqlFailure, verification: out.verification, witnesses: out.witnesses, pipeline: out.pipeline, receipt: out.receipt };
    const picked = Object.fromEntries(selection.map((k) => [k, full[k] ?? null]));
    return out.ok ? { data: { [field]: picked } } : { data: { [field]: picked }, errors: [{ message: out.error ?? "goal failed" }] };
  } catch (e) {
    return { data: null, errors: [{ message: String((e as Error)?.message ?? e) }] };
  }
}
