// Source discovery: hand RightClick X any URL and it works out what is there.
//
// Probes run in parallel: the URL itself (OpenAPI? GraphQL? MCP? a RightClick
// peer? a web page with forms?), plus well-known locations at the origin.
// Everything found is reflected; page hints are followed one level deep.

import { parseYaml } from "../core/yaml.ts";
import type { Capability, Reflection } from "../core/types.ts";
import { completeTypeReferences, INTROSPECTION_QUERIES, isIntrospection, reflectGraphQL } from "./graphql.ts";
import { McpClient, reflectMcpTools } from "./mcp.ts";
import { cancelBody, DISCOVERY_BODY_LIMIT, isEventStream, readBody, refuseDeniedResponse, request, slug, type Net } from "./net.ts";
import { isOpenAPI, reflectOpenAPI, settleUnstatedBase } from "./openapi.ts";
import { reflectWeb } from "./web.ts";

export interface Discovery {
  reflections: Reflection[];
  probes: Array<{ url: string; kind: string; ok: boolean; detail?: string }>;
}

const WELL_KNOWN = [
  "/.well-known/api-catalog",
  "/.well-known/rightclick.json",
  "/openapi.json",
  "/.well-known/openapi.json",
  "/swagger.json",
  "/api/openapi.json",
  "/graphql",
  "/mcp",
];

export type SourceKind = "openapi" | "graphql" | "mcp" | "peer" | "web";

/** RFC 9727 API catalog (a linkset): the environment lists its own APIs. */
function catalogLinks(body: unknown, base: string): string[] | null {
  const linkset = (body as any)?.linkset;
  if (!Array.isArray(linkset)) return null;
  const out = new Set<string>();
  for (const entry of linkset) {
    for (const rel of ["service-desc", "item", "service-meta"]) {
      for (const link of entry?.[rel] ?? []) if (typeof link?.href === "string") out.add(new URL(link.href, base).toString());
    }
  }
  return [...out];
}

const CATALOG_LIMIT = 50;

async function graphqlReflection(net: Net, body: unknown, url: string, probes: Discovery["probes"]): Promise<Reflection> {
  await completeTypeReferences(body, async query => {
    const response = await request(net, url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query }) });
    refuseDeniedResponse(response);
    const result = await readBody(response, DISCOVERY_BODY_LIMIT);
    return response.ok ? result : null;
  }, (ok, detail) => probes.push({ url, kind: "graphql-type-references", ok, detail }));
  return reflectGraphQL(body, url);
}

/** A contract published as YAML (OpenAPI / Swagger) is read as the same document. */
function yamlContract(body: unknown): unknown {
  if (typeof body !== "string" || !/^\s*(---\s*\n)?\s*(openapi|swagger)\s*:/.test(body)) return body;
  try {
    const doc = parseYaml(body);
    return doc && typeof doc === "object" ? doc : body;
  } catch {
    return body;
  }
}

/**
 * An API's root often answers with a small JSON index pointing at its contracts
 * ({"versions":{"v2":{"openapi":"/v2/openapi.json"}}}). Collect those links, bounded.
 */
function contractLinks(body: unknown, base: string): string[] {
  const out = new Set<string>();
  const key = /^(openapi|swagger|spec|api[-_]?docs|service[-_]?desc|schema[-_]?url)$/i;
  const looksLikeContract = /(openapi|swagger)(\.json)?$|api-docs$/i;
  const walk = (v: unknown, k: string, depth: number) => {
    if (out.size >= 10 || depth > 4) return;
    if (typeof v === "string") {
      if ((key.test(k) || looksLikeContract.test(v)) && !/\s/.test(v) && v.length < 300) {
        try {
          out.add(new URL(v, base).toString());
        } catch {
          /* not a URL */
        }
      }
    } else if (Array.isArray(v)) v.slice(0, 20).forEach((x) => walk(x, k, depth + 1));
    else if (v && typeof v === "object") for (const [kk, vv] of Object.entries(v).slice(0, 40)) walk(vv, kk, depth + 1);
  };
  walk(body, "", 0);
  return [...out];
}

export async function discover(net: Net, source: string, opts: { deep?: boolean; mcp?: (url: string) => McpClient; kind?: SourceKind; viaCatalog?: boolean } = {}): Promise<Discovery> {
  const url = new URL(source);
  const probes: Discovery["probes"] = [];
  // When a directory already says what a source is, learn it with one probe, not ten
  // (edge runtimes cap outbound requests per invocation).
  if (opts.kind) return { reflections: await probeKind(net, url.toString(), opts.kind, probes, opts), probes };
  const found = new Map<string, Reflection>();
  const keep = (r: Reflection | null) => {
    if (r && (r.capabilities.length || r.provider.source !== "web")) found.set(r.provider.id, r);
  };

  const direct = await probeUrl(net, url.toString(), probes, opts);
  for (const r of direct.reflections) keep(r);

  const isRoot = url.pathname === "/" || url.pathname === "";
  if ((isRoot || opts.deep) && !direct.definitive) {
    const extra = await Promise.all(
      WELL_KNOWN.map((p) => probeUrl(net, new URL(p, url.origin).toString(), probes, { ...opts, quiet: true })),
    );
    const all = extra.flatMap((e) => e.reflections);
    // Another RightClick X instance: federate its graph, not its own context_* tools.
    const peer = all.find((r) => r.provider.source === "peer");
    for (const r of peer ? [peer] : all) keep(r);
    // The environment publishes an API catalog: discover every service it lists (one level, capped).
    const listed = opts.viaCatalog ? [] : extra.flatMap((e) => e.catalog ?? []).slice(0, CATALOG_LIMIT);
    if (listed.length) probes.push({ url: new URL("/.well-known/api-catalog", url.origin).toString(), kind: "api-catalog", ok: true, detail: `${listed.length} services listed` });
    const nested = await Promise.all(listed.map((href) => discover(net, href, { ...opts, deep: false, viaCatalog: true }).catch(() => null)));
    for (const d of nested) {
      if (!d) continue;
      probes.push(...d.probes);
      for (const r of d.reflections) keep(r);
    }
  }
  for (const hint of direct.hints.slice(0, 5)) {
    const e = await probeUrl(net, hint, probes, opts);
    for (const r of e.reflections) keep(r);
  }
  return { reflections: [...found.values()], probes };
}

async function probeKind(net: Net, url: string, kind: SourceKind, probes: Discovery["probes"], opts: { mcp?: (url: string) => McpClient }): Promise<Reflection[]> {
  try {
    if (kind === "mcp") {
      const client = opts.mcp?.(url) ?? new McpClient(url, net);
      const tools = await client.listTools();
      probes.push({ url, kind, ok: true, detail: `${tools.length} tools` });
      return [reflectMcpTools(tools, url, client.serverInfo.name)];
    }
    if (kind === "graphql") {
      for (const query of INTROSPECTION_QUERIES) {
        const res = await request(net, url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ query }) });
        const body = await readBody(res, DISCOVERY_BODY_LIMIT);
        if (res.ok && isIntrospection(body)) {
          const r = await graphqlReflection(net, body, url, probes);
          probes.push({ url, kind, ok: true, detail: `${r.capabilities.length} fields` });
          return [r];
        }
      }
      throw new Error("introspection failed");
    }
    const res = await request(net, url, { headers: { accept: "application/json, text/html;q=0.9" } });
    if (!res.ok) { cancelBody(res); throw new Error(`HTTP ${res.status}`); }
    const body = yamlContract(await readBody(res, DISCOVERY_BODY_LIMIT));
    if (kind === "openapi" && isOpenAPI(body)) {
      const r = await settleUnstatedBase(net, body as any, url, reflectOpenAPI(body as any, url));
      probes.push({ url, kind, ok: true, detail: `${r.capabilities.length} operations` });
      return [r];
    }
    if (kind === "peer") return [await reflectPeer(net, new URL(url).origin)];
    if (kind === "web" && typeof body === "string") return [reflectWeb(body, url)];
    throw new Error(`not a ${kind} source`);
  } catch (e) {
    probes.push({ url, kind, ok: false, detail: String((e as Error)?.message ?? e).slice(0, 200) });
    return [];
  }
}

async function probeUrl(
  net: Net,
  url: string,
  probes: Discovery["probes"],
  opts: { mcp?: (url: string) => McpClient; quiet?: boolean },
): Promise<{ reflections: Reflection[]; hints: string[]; definitive: boolean; catalog?: string[] }> {
  const reflections: Reflection[] = [];
  let hints: string[] = [];
  let triedMcp = false;
  // 1. GET: specs, peers and pages.
  try {
    const res = await request(net, url, { headers: { accept: "application/json, text/html;q=0.9, */*;q=0.5" } });
    if (res.ok) {
      // A discovery GET may open an SSE subscription, whose body never ends.
      // Close only that probe and negotiate MCP normally; the media type alone
      // does not establish a capability or authorise any tool execution.
      const streaming = isEventStream(res);
      if (streaming) {
        cancelBody(res);
        triedMcp = true;
        const reflected = await probeKind(net, url, "mcp", probes, opts);
        if (reflected.length) return { reflections: reflected, hints: [], definitive: true };
      }
      // Failed MCP negotiation leaves GraphQL eligible; never read the discarded GET.
      const body = streaming ? null : yamlContract(await readBody(res, DISCOVERY_BODY_LIMIT));
      const listed = catalogLinks(body, url);
      if (listed) return { reflections: [], hints: [], definitive: false, catalog: listed };
      const linked = body && typeof body === "object" && !(body as any).openapi && !(body as any).swagger ? contractLinks(body, url) : [];
      if (linked.length && !(body as any).paths && !(body as any).data) {
        probes.push({ url, kind: "index", ok: true, detail: `links ${linked.length} contract(s)` });
        return { reflections: [], hints: linked, definitive: false };
      }
      if (isOpenAPI(body)) {
        const r = await settleUnstatedBase(net, body as any, url, reflectOpenAPI(body as any, url));
        probes.push({ url, kind: "openapi", ok: true, detail: `${r.capabilities.length} operations` });
        return { reflections: [r], hints: [], definitive: true };
      }
      if (body && typeof body === "object" && (body as any).rightclick) {
        const r = await reflectPeer(net, new URL(url).origin);
        probes.push({ url, kind: "peer", ok: true, detail: `${r.capabilities.length} federated capabilities` });
        return { reflections: [r], hints: [], definitive: true };
      }
      if (typeof body === "string" && /<html|<form|<!doctype/i.test(body)) {
        // A page answering a well-known probe is a catch-all route (or a GraphQL
        // playground): don't reflect it as a page, but keep probing the URL.
        if (!opts.quiet) {
          const r = reflectWeb(body, url);
          hints = (r.provider.meta?.hints as string[]) ?? [];
          probes.push({ url, kind: "web", ok: r.capabilities.length > 0, detail: `${r.capabilities.length} forms, ${hints.length} hints` });
          reflections.push(r);
        }
      }
    } else {
      cancelBody(res);
    }
  } catch (e) {
    if (!opts.quiet) probes.push({ url, kind: "get", ok: false, detail: String((e as Error).message ?? e) });
  }
  // 2. POST GraphQL introspection (shallower retry for depth-limited servers).
  for (const query of INTROSPECTION_QUERIES) {
    try {
      const res = await request(net, url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ query }),
      });
      const body = await readBody(res, DISCOVERY_BODY_LIMIT);
      if (res.ok && isIntrospection(body)) {
        const r = await graphqlReflection(net, body, url, probes);
        probes.push({ url, kind: "graphql", ok: true, detail: `${r.capabilities.length} fields` });
        return { reflections: [r], hints, definitive: true };
      }
      // Only retry when the server answered like GraphQL (an errors array).
      if (!(body && typeof body === "object" && Array.isArray((body as any).errors))) break;
    } catch {
      break;
    }
  }
  // 3. MCP initialize + tools/list.
  if (!triedMcp) try {
    const client = opts.mcp?.(url) ?? new McpClient(url, net);
    const tools = await client.listTools();
    const r = reflectMcpTools(tools, url, client.serverInfo.name);
    probes.push({ url, kind: "mcp", ok: true, detail: `${tools.length} tools` });
    return { reflections: [r], hints, definitive: true };
  } catch {
    /* not mcp */
  }
  if (!reflections.length && !opts.quiet) probes.push({ url, kind: "unknown", ok: false, detail: "no supported contract found" });
  return { reflections, hints, definitive: false };
}

export async function reflectPeer(net: Net, origin: string): Promise<Reflection> {
  const res = await request(net, `${origin}/api/graph`, { headers: { accept: "application/json" } });
  if (!res.ok) { cancelBody(res); throw new Error(`peer ${origin} -> HTTP ${res.status}`); }
  const g = (await readBody(res, DISCOVERY_BODY_LIMIT)) as { name?: string; region?: string; capabilities: Capability[] };
  const host = new URL(origin).host;
  const providerId = `peer:${slug(host)}`;
  const capabilities: Capability[] = g.capabilities
    // Builtins exist everywhere; federate what is unique to the peer.
    .filter((c) => c.source !== "peer" && c.source !== "builtin")
    .map((c) => ({
      ...c,
      id: `${providerId}:${c.id}`,
      provider: providerId,
      source: "peer",
      tags: [...c.tags, "federated", host, ...(g.region ? [g.region] : [])],
      invoke: { kind: "peer", endpoint: origin, id: c.id },
    }));
  return {
    provider: {
      id: providerId,
      title: `Peer ${g.name ?? host}${g.region ? ` (${g.region})` : ""}`,
      source: "peer",
      origin,
      learnedAt: new Date().toISOString(),
      capabilityIds: capabilities.map((c) => c.id),
      meta: { region: g.region },
    },
    capabilities,
  };
}
