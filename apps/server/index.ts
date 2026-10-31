// The local service: structured HTTP, observable jobs, the MCP endpoint, and EXAPT LAB. It reads real
// engine state and has no data of its own. Bound to loopback, it refuses requests whose Host or
// Origin is not local, so a web page in the operator's browser cannot reach it.
import fs from "node:fs";
import path from "node:path";
import { createRcxHandler, serve } from "../../packages/rcx-adapter/index.ts";
import { assertGoalSafe, compactGap, type Exapt, type Objective } from "../../packages/protocol/engine.ts";
import { dispatch, handle, TOOLS, type JsonRpc } from "../../packages/protocol/mcp.ts";
import { Refused } from "../../packages/shared/index.ts";
import { reprLabel, type Goal } from "../../packages/capability-universe/index.ts";

const PUBLIC = path.join(import.meta.dirname, "../lab/public");
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body, null, 1), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

const LOCAL = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

function rejectForeign(req: Request): Response | null {
  const host = req.headers.get("host") ?? "";
  if (!LOCAL.test(host)) return json({ error: "this service answers on loopback only" }, 403);
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      if (!LOCAL.test(new URL(origin).host)) return json({ error: "cross-origin requests are refused" }, 403);
    } catch {
      return json({ error: "cross-origin requests are refused" }, 403);
    }
  }
  return null;
}

function statusOf(e: unknown): number {
  const code = (e as Refused).code;
  if (!code) return 500;
  return /unknown/.test(code) ? 404 : 422;
}

export function createHandler(exapt: Exapt, opts: { goals?: Array<{ id: string; title: string; goal: Goal; base: string }> } = {}) {
  const rcx = createRcxHandler(exapt.host.rc, { open: true });
  return async (req: Request): Promise<Response> => {
    const foreign = rejectForeign(req);
    if (foreign) return foreign;
    const url = new URL(req.url);
    const p = url.pathname.replace(/\/+$/, "") || "/";
    const seg = p.split("/").filter(Boolean).map(decodeURIComponent);
    const body = async () => (await req.json().catch(() => ({}))) as Record<string, any>;
    try {
      if (req.method === "GET" && !p.startsWith("/api") && !p.startsWith("/rcx")) {
        const file = path.join(PUBLIC, p === "/" ? "index.html" : p);
        if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return json({ error: "not found" }, 404);
        return new Response(fs.readFileSync(file), { headers: { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" } });
      }
      if (p === "/mcp" || p === "/api/mcp") {
        if (req.method !== "POST") return new Response("MCP endpoint: POST JSON-RPC here.", { status: 405, headers: { allow: "POST" } });
        const raw = (await req.json()) as JsonRpc | JsonRpc[];
        const msgs = Array.isArray(raw) ? raw : [raw];
        const out = (await Promise.all(msgs.map((m) => handle(exapt, m)))).filter((m): m is JsonRpc => !!m);
        return out.length ? json(Array.isArray(raw) ? out : out[0]) : new Response(null, { status: 202 });
      }
      if (p.startsWith("/rcx")) {
        const inner = new URL(req.url);
        inner.pathname = p.slice(4) || "/";
        return rcx(new Request(inner, req));
      }
      if (req.method === "GET" && p === "/api/health") return json({ ok: true, version: "0.1.0-rc.1" });
      if (req.method === "GET" && p === "/api/state") {
        const s = exapt.summary({ limit: 1 });
        return json({
          counts: s.counts, model: exapt.config.model ? { provider: exapt.config.model.provider, model: exapt.config.model.model, real: exapt.config.model.real } : null,
          strategy: exapt.config.strategy, budget: exapt.config.budget, publish: exapt.config.publish, boundary: { backend: exapt.backend.name, enforces: exapt.backend.enforces, notEstablished: exapt.backend.notEstablished },
          programSandbox: exapt.host.sandbox?.kind ?? null, programs: exapt.config.programs, tools: TOOLS.length, receipts: exapt.host.rc.chain.receipts.length, goals: (opts.goals ?? []).map((g) => ({ id: g.id, title: g.title, goal: g.goal })),
        });
      }
      if (req.method === "GET" && p === "/api/universe") {
        const nodes = exapt.universe.search(url.searchParams.get("q") ?? "", { limit: 400 });
        const usable = exapt.universe.usable().map((t) => ({ id: t.id, name: t.name, kind: t.kind, input: t.contract.input ? reprLabel(t.contract.input.repr) : null, output: t.contract.output ? reprLabel(t.contract.output.repr) : null, required: t.contract.input?.requiredFields ?? [], influential: t.contract.input?.influentialFields ?? [], claims: t.contract.claims, probes: t.contract.probes }));
        return json({ nodes, tools: usable, flow: exapt.universe.flow().edges });
      }
      if (req.method === "POST" && p === "/api/discover") return json(await exapt.discover({ refresh: !!(await body()).refresh }));
      if (req.method === "POST" && p === "/api/analyse") {
        const b = await body();
        const named = opts.goals?.find((g) => g.id === b.goalId);
        const goal = (named?.goal ?? b.goal) as Goal;
        if (!named) assertGoalSafe(goal, exapt.config.dataRoots ?? []);
        const a = await exapt.analyse(goal, named?.base ?? exapt.config.home);
        return json({ ...a, gaps: a.gaps.map(compactGap) });
      }
      if (seg[0] === "api" && seg[1] === "runs") {
        if (req.method === "GET" && !seg[2]) return json(exapt.runs(Number(url.searchParams.get("limit") ?? 30)).map((r) => ({ id: r.id, goal: r.goal.id, intent: r.goal.intent, status: r.status, stage: r.stage, outcome: r.outcome, startedAt: r.startedAt, finishedAt: r.finishedAt, capability: r.capability, synthesis: r.synthesis })));
        if (req.method === "POST" && !seg[2]) {
          const b = await body();
          const named = opts.goals?.find((g) => g.id === b.goalId);
          const goal = (named?.goal ?? b.goal) as Goal;
          if (!named) assertGoalSafe(goal, exapt.config.dataRoots ?? []);
          const r = await exapt.startInvention(goal, named?.base ?? exapt.config.home, { wait: false, ...(b.strategy ? { strategy: b.strategy } : {}), ...(b.seed !== undefined ? { seed: b.seed } : {}) });
          return json({ id: r.id, status: r.status }, 202);
        }
        const run = exapt.run(seg[2]);
        if (!run) return json({ error: `no run ${seg[2]}` }, 404);
        if (req.method === "GET" && seg[3] === "events") return json(exapt.runEvents(seg[2]));
        if (req.method === "GET" && !seg[3]) return json(run);
      }
      if (seg[0] === "api" && seg[1] === "capabilities") {
        if (req.method === "GET" && !seg[2]) return json(exapt.memory({ limit: 200 }));
        const id = seg[2];
        if (req.method === "GET" && !seg[3]) return json(exapt.explain(id, "full"));
        const b = req.method === "POST" ? await body() : {};
        if (req.method === "POST" && seg[3] === "use") return json(await exapt.use(id, String(b.input ?? ""), { encoding: b.encoding }));
        if (req.method === "POST" && seg[3] === "revalidate") return json(await exapt.revalidate(id));
        if (req.method === "POST" && seg[3] === "evolve") return json(await exapt.evolve(id, (b.objective ?? "smaller") as Objective));
      }
      if (req.method === "GET" && p === "/api/evolution") return json(exapt.evolution());
      if (req.method === "GET" && p === "/api/failures") return json(exapt.vault.rejected(100));
      if (req.method === "GET" && p === "/api/events") return events(exapt);
      if (req.method === "POST" && seg[0] === "api" && seg[1] === "tools" && seg[2]) return json(await dispatch(exapt, seg[2], await body()));
      return json({ error: "not found" }, 404);
    } catch (e) {
      const r = e as Refused;
      return json({ error: r.message ?? String(e), code: r.code, next: r.next }, statusOf(e));
    }
  };
}

function events(exapt: Exapt): Response {
  const enc = new TextEncoder();
  let stop: (() => void) | null = null;
  const stream = new ReadableStream<Uint8Array>({
    start(ctrl) {
      const send = (e: unknown) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
      const ping = setInterval(() => ctrl.enqueue(enc.encode(": ping\n\n")), 15_000);
      exapt.events.on("event", send);
      stop = () => {
        clearInterval(ping);
        exapt.events.off("event", send);
      };
    },
    cancel() {
      stop?.();
    },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" } });
}

export { serve };
