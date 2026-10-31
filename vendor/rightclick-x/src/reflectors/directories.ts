// Public capability directories: where research finds new powers worldwide.
// Each directory turns a topic into learnable sources; context_learn then
// pulls any of them into the live graph.

import { tokenize } from "../core/graph.ts";
import { request, type Net } from "./net.ts";

export interface Candidate {
  directory: string;
  name: string;
  title: string;
  description: string;
  source: string;
  kind: "openapi" | "mcp" | "graphql";
  score: number;
}

export interface Directory {
  id: string;
  title: string;
  url: string;
  search(net: Net, topic: string, limit: number): Promise<Candidate[]>;
}

/** Rarity-weighted relevance: rare terms ("exchange", "holiday") outweigh common ones ("api", "page"). */
function scorer(docs: string[][]) {
  const df = new Map<string, number>();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) ?? 0) + 1);
  const N = docs.length || 1;
  const idf = (t: string) => Math.log(1 + N / (1 + (df.get(t) ?? 0)));
  return (topic: string, weighted: Array<[string, number]>) => {
    const q = [...new Set(tokenize(topic))];
    const max = q.reduce((s, t) => s + idf(t), 0) || 1;
    let score = 0;
    for (const t of q) {
      const w = Math.max(0, ...weighted.map(([text, weight]) => (new Set(tokenize(text)).has(t) ? weight : 0)));
      score += w * idf(t);
    }
    return score / (max * 3);
  };
}

function score(topic: string, ...fields: string[]): number {
  const q = tokenize(topic);
  const doc = new Set(tokenize(fields.join(" ")));
  return q.reduce((s, t) => s + (doc.has(t) ? 1 : 0), 0) / (q.length || 1);
}

let apisGuruCache: { at: number; data: Record<string, any> } | null = null;
let apisGuruScorer: ReturnType<typeof scorer> | null = null;

export const APIS_GURU: Directory = {
  id: "apis.guru",
  title: "APIs.guru OpenAPI directory",
  url: "https://api.apis.guru/v2/list.json",
  async search(net, topic, limit) {
    if (!apisGuruCache || Date.now() - apisGuruCache.at > 6 * 3600_000) {
      const res = await request(net, this.url, { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`apis.guru -> HTTP ${res.status}`);
      apisGuruCache = { at: Date.now(), data: (await res.json()) as Record<string, any> };
      apisGuruScorer = null;
    }
    const out: Candidate[] = [];
    const entries = Object.entries(apisGuruCache.data).filter(([, e]) => e.versions?.[e.preferred]?.swaggerUrl);
    apisGuruScorer ??= scorer(entries.map(([name, e]) => tokenize(`${name} ${e.versions[e.preferred].info?.title ?? ""} ${String(e.versions[e.preferred].info?.description ?? "").slice(0, 500)}`)));
    for (const [name, entry] of entries) {
      const v = entry.versions[entry.preferred];
      const cats = (v.info?.["x-apisguru-categories"] ?? []).join(" ");
      const s = apisGuruScorer(topic, [
        [`${name} ${v.info?.title ?? ""}`, 3],
        [cats, 2],
        [String(v.info?.description ?? "").slice(0, 500), 1],
      ]);
      if (s > 0.15) {
        out.push({
          directory: this.id,
          name,
          title: v.info?.title ?? name,
          description: String(v.info?.description ?? "").replace(/\s+/g, " ").slice(0, 200),
          source: v.swaggerUrl,
          kind: "openapi",
          score: s,
        });
      }
    }
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  },
};

export const MCP_REGISTRY: Directory = {
  id: "mcp-registry",
  title: "Official MCP Registry",
  url: "https://registry.modelcontextprotocol.io/v0/servers",
  async search(net, topic, limit) {
    // The registry matches one term at a time; query the most specific terms and merge.
    const terms = [...new Set(tokenize(topic))].sort((a, b) => b.length - a.length).slice(0, 3);
    const raw = new Map<string, any>();
    let failures = 0;
    await Promise.all(
      [topic, ...terms].map(async (q) => {
        try {
          const res = await request(net, `${this.url}?search=${encodeURIComponent(q)}&limit=50`, { headers: { accept: "application/json" } });
          if (!res.ok) return void (await res.body?.cancel());
          const j: any = await res.json();
          for (const item of j.servers ?? []) {
            const sv = item.server ?? item;
            if (sv?.name) raw.set(sv.name, sv);
          }
        } catch {
          failures++; // one slow query must not sink the rest
        }
      }),
    );
    if (!raw.size && failures) throw new Error("mcp registry unreachable");
    const out: Candidate[] = [];
    for (const s of raw.values()) {
      const remote = (s.remotes ?? []).find((r: any) => r.type === "streamable-http" || r.transport_type === "streamable-http" || r.type === "http");
      if (!remote?.url || remote.url.includes("{")) continue;
      out.push({
        directory: this.id,
        name: s.name,
        title: s.title ?? s.name,
        description: String(s.description ?? "").slice(0, 200),
        source: remote.url,
        kind: "mcp",
        score: score(topic, s.name, s.title ?? "", s.description ?? ""),
      });
    }
    return out.filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, limit);
  },
};

export const DEFAULT_DIRECTORIES: Directory[] = [APIS_GURU, MCP_REGISTRY];
