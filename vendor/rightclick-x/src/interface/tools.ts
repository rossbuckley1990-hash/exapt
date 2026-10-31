// The context_* family: a fixed, small interface over an unbounded graph.
// Agents never get a new tool when the graph grows; they research, learn,
// compose and run through these thirteen.

import type { RightClick } from "../runtime.ts";
import { applyView, parseView, OUTPUT_BUDGET, type OutputView } from "../core/view.ts";

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "number", description });
const bool = (description: string) => ({ type: "boolean", description });
const predicates = {
  type: "array",
  description: 'Outcome checks on the result, e.g. [{"op":"contains","value":"Lisbon"}, {"op":"gt","path":"temperature","value":-50}]. ops: exists, equals, contains, matches, type, gt, lt, length_gt. Passing them makes a result "checked"; only an independent witness makes it "verified".',
  items: { type: "object" },
};
const witnesses = {
  type: "array",
  description: 'Independent outcome checks, repeated for every saved invocation. Discover a read-only checker in the environment. Example: [{"capability":"<checker id>","args":{"order_id":{"input":"order_id"},"tax_amount":{"output":""}},"verify":[{"op":"equals","path":"valid","value":true}]}]. input paths read this invocation\'s have values; output paths read the candidate result (empty string = whole result); value supplies a literal. The checker must be a separate provider and must pass its predicates. Its contract is pinned on save; a changed checker fails closed. Or recompute: an independent implementation of the same outcome (a capability, or a saved pipeline none of whose providers produced the result) given only inputs and values, with agree, must reach the same result: [{"capability":"<other implementation>","args":{"text":{"input":"text"}},"agree":{"mode":"trimmed"}}].',
  items: obj({ capability: str("Exact read-only checker capability id, or a crystallized pipeline of read-only steps."), args: { type: "object", additionalProperties: { oneOf: [obj({ input: str("Path in the invocation inputs.") }, ["input"]), obj({ output: str("Path in the candidate output; empty string selects all of it.") }, ["output"]), obj({ value: {} }, ["value"])] } }, verify: predicates,
    agree: { ...obj({ path: str("Path in the witness result (default: all of it)."), candidate: str("Path in the candidate result (default: all of it)."), mode: { type: "string", enum: ["exact", "trimmed", "number"], description: "exact (default), trimmed (same text without surrounding whitespace) or number (within tolerance)." }, tolerance: num("Largest allowed difference, with mode number (default 0).") }), description: "The witness recomputes the outcome from inputs and values (never from the candidate) and must agree with it. Replaces verify." } }, ["capability", "args"]),
};

const view = {
  ...obj({
    select: str('Path into the output, e.g. "items", "0.sequence.length", or "isoforms.accession" to map over an array.'),
    fields: { type: "array", items: { type: "string" }, description: 'Project each element onto these paths, e.g. ["accession","sequence.length"].' },
    count: bool("Return only the number of elements, keys or characters of the selected value."),
    offset: num("Start of a slice of the selected array (default 0)."),
    limit: num("Length of a slice of the selected array."),
    full: bool("Return the selected value whole, even when it is over the response budget."),
  }),
  description: `What to return of the output: a count, a projection or a slice. Without a view, an output over ${OUTPUT_BUDGET} characters of JSON is withheld whole (never cut) and summarised by size, count and shape. The run record and receipt digest always cover the full output.`,
};

export const TOOLS = [
  {
    name: "context_runtime",
    description: "Identify this RightClick X instance: version, runtime (node/bun/deno/workers/browser), region, graph size and powers, receipt-chain head.",
    inputSchema: obj({}),
  },
  {
    name: "context_research",
    description:
      "Refresh operator-configured environment catalogs: observe advertised sources, learn supported contracts within the approved discovery scope, and withdraw catalog-owned sources removed by a valid catalog. Discovery never grants execution authority. Also report runtime/platform bindings and semantic gaps; with a topic, search public API directories. Pass learn:N to learn the top N public-directory candidates.",
    inputSchema: obj({ topic: str("What to look for, e.g. 'weather', 'translation', 'geocoding'."), limit: num("Candidates per directory (default 5)."), learn: num("Learn the top N candidates immediately.") }),
  },
  {
    name: "context_learn",
    description:
      "Discover capabilities from a URL (OpenAPI, GraphQL, MCP, peer or web page) or an operator-authorised local program (cli:/absolute/path). Reports learned capabilities and graph changes; discovery never grants execution authority.",
    inputSchema: obj({ source: str("URL or cli:/absolute/path to an authorised program."), sources: { type: "array", items: { type: "string" } }, deep: bool("Also probe well-known locations at the origin.") }),
  },
  {
    name: "context_forget",
    description: "Remove a provider and its capabilities from the live graph.",
    inputSchema: obj({ provider: str("Provider id from context_providers.") }, ["provider"]),
  },
  {
    name: "context_inspect",
    description: "Classify any value into the semantic type lattice (url, email, language, place, geo.lat, html, markdown, json, ...).",
    inputSchema: obj({ value: { description: "Any value." } }, ["value"]),
  },
  {
    name: "context_actions",
    description: "What can be done with this value right now: capabilities that accept it directly, plus every semantic type it can be turned into through multi-step pipelines.",
    inputSchema: obj({ value: { description: "A value to act on." }, type: str("Or a semantic type instead of a value."), limit: num("Max direct actions (default 25).") }),
  },
  {
    name: "context_explain",
    description: "Get a capability's execution contract: typed inputs/outputs, authority, restrictions, evidence, stored checks and limitations. Saved goals include reuse guidance and historical result declarations, not future-output guarantees. Default detail: run. Request full for raw synthetic examples, the full card, graph neighbours and run history.",
    inputSchema: obj({ id: str("Capability id (or a search phrase)."), detail: { type: "string", enum: ["run", "full"], description: "run (default) keeps execution constraints and evidence; full adds underlying detail." } }, ["id"]),
  },
  {
    name: "context_run",
    description: "Run one capability now. Saved goal:<slug> capabilities re-plan against the current environment, heal API changes and repeat their stored result checks and independent witnesses. Returns output, timing, receipt, verification and witness evidence. Optional predicates add checks; they never remove stored checks. A failed call to a learned API re-reads its contract once and retries the same operation if the API moved; an id that re-learning pointed at a different operation remains refused; caller acknowledgement cannot authorise the change. Large outputs: pass view to get a count, field projection or slice instead of the whole payload.",
    inputSchema: obj({ id: str("Capability id, or the explicit resume:<run-id> selector from context_run_status. HTTP recovery reads the retained result; host-enabled workflow recovery continues its exact remaining steps. Completed actions are never replayed. Omit args, verify and confirm when resuming; stored checks and current authority apply."), args: { type: "object", description: "Input arguments by port name." }, verify: predicates, confirm: bool("Required for capabilities labelled destructive."), view }, ["id"]),
  },
  {
    name: "context_run_status",
    description: "Read a previous run by runId, or list recent runs. Also reports whether the receipt chain is intact. With runId, view counts, projects or slices that run's recorded output without running it again.",
    inputSchema: obj({ runId: str("Run id."), limit: num("Recent runs to list."), view }),
  },
  {
    name: "context_compose",
    description:
      "Give what you have and the type you want; RightClick X discovers routes across the environment and (with run:true) executes, checks and repairs them. Currency/unit refinements require explicit conversions. Attach witnesses for independent business-outcome checks. publish saves a stable goal:<slug> capability another AI can discover with context_graph and invoke with context_run; its checks survive restart and API changes. A successful multi-step pipeline is also saved for reuse.",
    inputSchema: obj(
      {
        have: { type: "object", description: 'Named inputs, e.g. {"place":"Lisbon","language":"es"} or {"x":{"type":"url","value":"https://..."}}. With publish, {"to":{"value":"EUR","fixed":true}} pins an input inside the published goal instead of making it a parameter of its API.' },
        want: str("Desired semantic type, e.g. text, language, geo.lat, html, hash."),
        intent: str("Words describing the goal, e.g. 'weather forecast translated'."),
        run: bool("Execute the best plan."),
        verify: predicates,
        witnesses,
        maxSteps: num("Max pipeline length (default 4)."),
        confirm: bool("Required to run plans containing destructive capabilities."),
        publish: str("After a successful run, save this goal as goal:<slug> in the graph AND as /x/<slug> in the synthesized API. Checks and witnesses are retained and re-run on every invocation. Stored predicates make a goal \"checked\"; an independent witness makes it \"verified\"."),
        preserveExisting: bool("Refuse publication before execution if this slug already exists. Without this option a successful publication replaces the existing goal; publication is refused if the definition changes during execution."),
        acquire: bool("If nothing in the graph can do it: research public directories (APIs.guru, MCP Registry), learn the best candidates and re-plan."),
        through: { type: "array", items: { type: "string" }, description: "Anchors: capability ids or search phrases the pipeline must pass through; the planner wires the types between them." },
        inputBindings: { type: "object", description: 'For anchored CLI capabilities, map capability id to port-to-have-input names, e.g. {"cli:jq:stdout":{"options":"jqOptions"},"cli:shasum:invoke":{"options":"hashOptions"}}. Each binding is mandatory and retained with a published goal. Use fixed have inputs to pin options.' },
        risks: { type: "array", items: { type: "string", enum: ["read", "write", "external", "destructive"] }, description: 'Optional constraint: plan only with these risk labels, e.g. ["read"].' },
        require: { type: "array", items: { type: "string" }, description: 'Required information the result must carry, e.g. ["resolution"] or ["gene name"]. Use through to constrain capability ids. Plans are judged by the fields their result declares and by how each join is supported; only an established plan runs, otherwise the outcome says unavailable/unverified and nothing runs. After running, the output is checked for every term.' },
        origins: { type: "array", items: { type: "string" }, description: 'Optional egress policy, e.g. ["https://api.example.com"]: use only capabilities that send data to these origins, now and in every automatic repair. Saved with publish.' },
        view,
      },
      ["have", "want"],
    ),
  },
  {
    name: "context_graph",
    description: "Query the live graph. op: stats | types | search (query) | neighbors (id) | paths (from, to) | edges | export | authority. authority audits consequential execution capabilities and operator restrictions; it cannot change policy.",
    inputSchema: obj({ op: str("Operation."), id: str("Capability id."), query: str("Search text."), from: str("From semantic type."), to: str("To semantic type."), limit: num("Max results.") }, ["op"]),
  },
  {
    name: "context_providers",
    description: "Providers currently contributing capabilities: builtins, platform, OpenAPI, GraphQL, MCP, web, peers, crystallized pipelines.",
    inputSchema: obj({}),
  },
  {
    name: "context_watch",
    description: "Follow the graph as it changes: providers learned/forgotten, runs, crystallizations, research. Pass the returned cursor back as since; waitMs long-polls.",
    inputSchema: obj({ since: num("Cursor from a previous call."), waitMs: num("Wait up to this long for new events.") }),
  },
] as const;

/**
 * MCP tool annotations, so clients can make informed approval decisions.
 * Inspection tools only read RightClick X's own state; learn/research/forget
 * change the graph; run/compose reach other systems and may be destructive
 * (destructive capabilities additionally require confirm: true).
 */
const ANNOTATIONS: Record<string, { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean }> = {
  context_runtime: { title: "Identify this RightClick X instance", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_inspect: { title: "Classify a value", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_actions: { title: "What can be done with a value", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_explain: { title: "Explain a capability", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_graph: { title: "Query the capability graph", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_providers: { title: "List providers", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_run_status: { title: "Read run receipts", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_watch: { title: "Follow graph changes", readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_research: { title: "Survey the environment and directories", readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  context_learn: { title: "Learn a source's capabilities", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  context_forget: { title: "Forget a provider", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_run: { title: "Run a capability", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  context_compose: { title: "Compose and run a workflow", readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export const ANNOTATED_TOOLS = TOOLS.map((t) => ({ ...t, title: ANNOTATIONS[t.name].title, annotations: ANNOTATIONS[t.name] }));

export type ToolName = (typeof TOOLS)[number]["name"];

/** Shape what the client receives of an output; the stored run and its receipt keep all of it. */
function viewed<T extends { output?: unknown }>(rec: T, v: OutputView | undefined, again: string): T {
  if (rec.output === undefined) return rec;
  const { value, report } = applyView(rec.output, v, again);
  return report ? { ...rec, output: value, outputView: report } : rec;
}

const rerun = (runId: string) => `To view this output again without re-running: context_run_status {"runId":"${runId}","view":{…}}.`;

export async function dispatch(rc: RightClick, name: string, a: Record<string, any> = {}): Promise<unknown> {
  switch (name) {
    case "context_runtime":
      return rc.runtime();
    case "context_research":
      return rc.research({ topic: a.topic, limit: a.limit, learn: a.learn });
    case "context_learn":
      return rc.learn({ source: a.source, sources: a.sources, deep: a.deep });
    case "context_forget":
      return rc.forget(a.provider);
    case "context_inspect":
      return rc.inspect(a.value);
    case "context_actions":
      return rc.actions({ value: a.value, type: a.type, limit: a.limit });
    case "context_explain":
      if (a.detail !== undefined && !["run", "full"].includes(a.detail)) throw new Error("detail must be run or full");
      return rc.explainDeferred(a.id) ?? (a.detail === "full" ? rc.explain(a.id) : rc.explainForRun(a.id));
    case "context_run": {
      if ("acknowledgeChange" in a) throw new Error("acknowledgeChange is no longer supported: caller acknowledgement cannot authorise a changed operation");
      if ("resumeRunId" in a) throw new Error("resume uses the explicit resume:<run-id> selector");
      // Validate the view before running: a malformed view must not cost a side effect.
      const v = parseView(a.view);
      const r = await rc.run(a.id, a.args ?? {}, { verify: a.verify, confirm: a.confirm, acknowledgeChange: a.acknowledgeChange });
      return viewed(r, v, rerun(r.runId));
    }
    case "context_run_status": {
      const v = parseView(a.view);
      if (!a.runId) return { ...(rc.runStatus({ limit: a.limit }) as object), chain: await rc.verifyReceipts() };
      return viewed(rc.runStatus({ runId: a.runId }) as { runId: string; output?: unknown }, v, rerun(a.runId));
    }
    case "context_compose": {
      const v = parseView(a.view);
      const r = await rc.compose({ have: a.have ?? {}, want: a.want, intent: a.intent, run: a.run, verify: a.verify, witnesses: a.witnesses, maxSteps: a.maxSteps, risks: a.risks, through: a.through, inputBindings: a.inputBindings, origins: a.origins, require: a.require, acquire: a.acquire, publish: a.publish, preserveExisting: a.preserveExisting, confirm: a.confirm });
      if (!r.executed) return r;
      return { ...r, executed: viewed(r.executed, v, "To view a step's recorded output without re-running: context_run_status with a runId from executed.runs and a view.") };
    }
    case "context_graph":
      return rc.graphQuery(a as any);
    case "context_providers":
      return rc.providers();
    case "context_watch":
      return rc.watch({ since: a.since, waitMs: a.waitMs });
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}
