// One web-standard fetch handler: (Request) => Response. It runs unchanged on
// Cloudflare Workers, Deno Deploy, Bun.serve, Vercel/Netlify edge, and Node
// (via the adapter in entry/node-http.ts).
//
// Routes
//   GET  /                              live dashboard
//   GET  /.well-known/rightclick.json   public manifest (lets peers find us)
//   POST /mcp                           MCP Streamable HTTP (JSON responses)
//   GET  /api/graph                     graph export, used by federation
//   GET  /api/viz                       nodes + edges for the dashboard
//   GET  /events                        server-sent event stream of graph changes
//   POST /api/run                       run a capability (peers call this)
//   POST /api/<tool>                    any context_* tool, JSON in/out

import { VERSION, type RightClick } from "../runtime.ts";
import { DASHBOARD_HTML } from "./dashboard.ts";
import { dashboardMetrics, capabilityPage, capabilityState } from "./dashboard-state.ts";
import { executeGraphQL } from "./graphql-server.ts";
import { handle, type JsonRpc } from "./mcp-server.ts";
import { TOOLS, dispatch } from "./tools.ts";
import { authorityEvidenceReader, type AuthorityEvidenceSource } from "./authority-evidence.ts";

export interface HttpOptions {
  /** Bearer token required for every non-public route. */
  token?: string;
  /** Allow unauthenticated access (only sensible on loopback). */
  open?: boolean;
  /** Largest accepted request body (default 1 MiB). */
  maxBodyBytes?: number;
  /** Requests per minute per caller (bearer token, else client address); default 600, 0 disables. */
  ratePerMinute?: number;
  /** Optional host-owned native verifier. Read-only evidence, never execution permission. */
  authorityEvidence?: AuthorityEvidenceSource;
}

/** Token-bucket rate limiter, keyed per caller. */
class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();
  private perMinute: number;
  constructor(perMinute: number) {
    this.perMinute = perMinute;
  }
  take(key: string): boolean {
    if (!this.perMinute) return true;
    const now = Date.now();
    const b = this.buckets.get(key) ?? { tokens: this.perMinute, at: now };
    b.tokens = Math.min(this.perMinute, b.tokens + ((now - b.at) / 60_000) * this.perMinute);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value!);
    return true;
  }
}

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8", "access-control-allow-origin": "*" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });

function authorized(req: Request, opts: HttpOptions): boolean {
  if (opts.open && !opts.token) return true;
  if (!opts.token) return false;
  const got = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  if (got.length !== opts.token.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ opts.token.charCodeAt(i);
  return diff === 0;
}

export function createHandler(rc: RightClick, opts: HttpOptions = {}): (req: Request) => Promise<Response> {
  const limiter = new RateLimiter(opts.ratePerMinute ?? 600);
  const maxBody = opts.maxBodyBytes ?? 1024 * 1024;
  const authorityEvidence = authorityEvidenceReader(opts.authorityEvidence, link =>
    link.runtimeId === rc.activity.epoch &&
    !!rc.activity.forRun(link.runId)?.subjects?.includes(link.capabilityId));
  return async (req: Request) => {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-headers": "authorization, content-type, mcp-session-id, mcp-protocol-version",
        },
      });
    }
    if (req.method === "GET" && path === "/") {
      return new Response(DASHBOARD_HTML, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (req.method === "GET" && path === "/.well-known/rightclick.json") {
      return json({ rightclick: VERSION, name: rc.name, region: rc.info.region, runtime: rc.info.name, api: "/api", mcp: "/mcp", openapi: "/openapi.json", graphql: "/graphql", auth: opts.token ? "bearer" : opts.open ? "none" : "locked" });
    }
    if (req.method === "GET" && path === "/health") return json({ ok: true, version: VERSION });

    const caller = req.headers.get("authorization") ?? req.headers.get("cf-connecting-ip") ?? req.headers.get("x-forwarded-for") ?? "local";
    if (!limiter.take(caller)) return json({ error: "rate limited", hint: "Slow down or raise ratePerMinute." }, 429);
    const length = Number(req.headers.get("content-length") ?? 0);
    if (length > maxBody) return json({ error: `request body larger than ${maxBody} bytes` }, 413);

    if (!authorized(req, opts)) {
      return json(
        {
          error: "unauthorized",
          hint: opts.token ? "Send Authorization: Bearer <RCX_TOKEN>." : "This deployment has no RCX_TOKEN set, so its API is locked. Set the RCX_TOKEN secret to enable it.",
        },
        401,
      );
    }

    try {
      if (path === "/mcp") {
        if (req.method !== "POST") return new Response("MCP endpoint: POST JSON-RPC here.", { status: 405, headers: { allow: "POST" } });
        const body = (await req.json()) as JsonRpc | JsonRpc[];
        const msgs = Array.isArray(body) ? body : [body];
        const out = (await Promise.all(msgs.map((m) => handle(rc, m)))).filter((m): m is JsonRpc => !!m);
        if (!out.length) return new Response(null, { status: 202 });
        return json(Array.isArray(body) ? out : out[0]);
      }
      if (req.method === "GET" && path === "/api/graph") return json(rc.exportGraph());
      if (req.method === "GET" && path === "/openapi.json") return json(rc.openApi(url.origin));
      if (req.method === "POST" && path === "/graphql") return json(await executeGraphQL(rc, (await req.json().catch(() => ({}))) as any));
      const x = /^\/x\/([a-z0-9-]+)$/.exec(path);
      if (x && (req.method === "GET" || req.method === "POST")) {
        // GET is safe by HTTP's contract (links, prefetch, crawlers): only read-only goals answer it.
        const risk = rc.graph.get(`goal:${x[1]}`)?.risk;
        if (req.method === "GET" && risk && risk !== "read") return new Response(JSON.stringify({ error: `goal ${x[1]} can change state (${risk}); use POST` }), { status: 405, headers: { "content-type": "application/json", allow: "POST" } });
        const args = req.method === "GET" ? Object.fromEntries(url.searchParams) : ((await req.json().catch(() => ({}))) as Record<string, unknown>);
        const out = await rc.callPublished(x[1], args);
        return json(out, out.status === "pending" ? 202 : out.ok ? 200 : 502);
      }
      if (req.method === "GET" && path === "/api/viz") return json(viz(rc));
      if (req.method === "GET" && path === "/api/authority-evidence") return json(await authorityEvidence());
      if (req.method === "GET" && path === "/api/overview") return json({
        metrics: dashboardMetrics(rc), runtime: rc.runtime(), providers: rc.providers().slice(0, 200).map(p => ({ id: p.id, title: p.title, source: p.source, capabilities: p.capabilities })),
        providerCount: rc.graph.providers.size, providersOmitted: Math.max(0, rc.graph.providers.size - 200),
      });
      if (req.method === "GET" && path === "/api/activity") return json(rc.activity.read({
        after: url.searchParams.has("after") ? Number(url.searchParams.get("after")) : undefined,
        epoch: url.searchParams.get("epoch") ?? undefined, limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
      }));
      if (req.method === "GET" && path === "/api/capability") return json(capabilityState(rc, url.searchParams.get("id") ?? ""));
      if (req.method === "GET" && path === "/api/capabilities") return json(capabilityPage(rc, {
        search: url.searchParams.get("search") ?? undefined, provider: url.searchParams.get("provider") ?? undefined,
        offset: Number(url.searchParams.get("offset") ?? 0), limit: Number(url.searchParams.get("limit") ?? 25),
      }));
      if (req.method === "GET" && path === "/events") return events(rc, Number(url.searchParams.get("since") ?? rc.graph.cursor));
      if (req.method === "GET" && path === "/api/tools") return json(TOOLS);
      if (req.method === "POST" && path === "/api/run") {
        const a = (await req.json()) as any;
        return json(await rc.run(a.id, a.args ?? {}, { verify: a.verify, acknowledgeChange: a.acknowledgeChange }));
      }
      const m = /^\/api\/(?:context_)?([a-z_]+)$/.exec(path);
      if (req.method === "POST" && m) {
        const name = `context_${m[1]}`;
        if (!TOOLS.some((t) => t.name === name)) return json({ error: `unknown tool ${name}` }, 404);
        const args = req.headers.get("content-length") === "0" ? {} : await req.json().catch(() => ({}));
        return json(await dispatch(rc, name, args as Record<string, unknown>));
      }
      return json({ error: "not found" }, 404);
    } catch (e) {
      return json({ error: String((e as Error)?.message ?? e) }, 400);
    }
  };
}

function viz(rc: RightClick) {
  const nodes = rc.graph.list().map((c) => ({ id: c.id, title: c.title, provider: c.provider, source: c.source }));
  const links = rc.graph.sampleEdges(4000);
  return { nodes, links, powers: rc.graph.powers(), metrics: dashboardMetrics(rc), providers: rc.providers(), runtime: rc.runtime(), recent: rc.runStatus({ limit: 15 }) };
}

function events(rc: RightClick, since: number): Response {
  const enc = new TextEncoder();
  let off: (() => void) | null = null;
  let ping: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (e: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      for (const e of rc.graph.since(since)) send(e);
      off = rc.graph.subscribe(send);
      ping = setInterval(() => ctrl.enqueue(enc.encode(`: ping\n\n`)), 15_000);
    },
    cancel() {
      off?.();
      if (ping) clearInterval(ping);
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}
