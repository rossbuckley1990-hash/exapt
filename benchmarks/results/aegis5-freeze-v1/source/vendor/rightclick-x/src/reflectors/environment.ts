// Operator-approved environment advertisements. This adapter reads RFC 9727
// JSON linksets; it neither scans addresses nor supplies execution authority.
import { sha256 } from "../core/ledger.ts";
import { cancelBody, checkUrl, readBody, request, type Net } from "./net.ts";

export interface EnvironmentOptions {
  catalogs: string[];
  /** Additional origins whose advertised contracts may be read. No wildcards. */
  origins?: string[];
}
export interface SourceObservation {
  source: string;
  catalog: string;
  relation: "service-desc" | "item";
  kind?: "openapi";
  status: "advertised" | "learned" | "blocked" | "unsupported" | "unavailable" | "removed" | "stale";
  observedAt: string;
  advertisementDigest: string;
  reachable: boolean | "unknown";
  authenticated: "unknown";
  authority: "not-assessed";
  credentials: "configured" | "absent";
  providers: string[];
}
export interface CatalogObservation {
  catalog: string;
  checkedAt: string;
  status: "observed" | "blocked" | "unavailable" | "authentication-required" | "forbidden" | "rate-limited" | "invalid";
  digest?: string;
}
export interface EnvironmentReport {
  catalogs: CatalogObservation[];
  sources: SourceObservation[];
}
export const ENVIRONMENT_SOURCE_LIMIT = 64;

function safeUrl(value: unknown, base?: string): string {
  if (typeof value !== "string" || value.length > 2048) throw new Error("invalid environment URL");
  const u = new URL(value, base);
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password || u.search || u.hash)
    throw new Error("environment URLs must be HTTP(S), without credentials, query or fragment");
  return u.href;
}

/** Validate host configuration; no context_* tool can install or widen it. */
export function environmentOptions(raw: unknown): EnvironmentOptions | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!value || !Array.isArray(value.catalogs) || value.catalogs.length > 8 ||
      (value.origins !== undefined && (!Array.isArray(value.origins) || value.origins.length > 64)))
    throw new Error("environment requires at most 8 catalog URLs and 64 additional origins");
  const catalogs = [...new Set<string>(value.catalogs.map((s: unknown) => safeUrl(s)))];
  const origins = [...new Set<string>((value.origins ?? []).map((s: unknown) => {
    const url = safeUrl(s);
    if (new URL(url).pathname !== "/") throw new Error("environment origins must not contain a path");
    return new URL(url).origin;
  }))];
  return { catalogs, origins };
}

/** A separate scope intersects the host policy, including every redirect hop. */
export function environmentNet(net: Net, options: EnvironmentOptions): Net {
  const configured = new Set([...options.catalogs.map(s => new URL(s).origin), ...(options.origins ?? [])]);
  const origins = [...configured].filter(o => net.policy?.origins === undefined || net.policy.origins.includes(o));
  let requests = 0;
  return {
    ...net, policy: { blockPrivate: true, ...net.policy, origins },
    fetch: async (input, init) => {
      if (++requests > 128) throw new Error("environment discovery request budget exhausted");
      const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      if (!["GET", "HEAD"].includes(method)) throw new Error("environment advertisement discovery permits only reads");
      return net.fetch(input, init);
    },
  };
}

/** First protocol family: direct service-desc OpenAPI contracts. Item links are
 * observations only; unknown protocols, nested catalogs and private addresses
 * need separate, explicit support/policy, never speculative execution. */
export async function observeCatalog(net: Net, catalog: string): Promise<{ observation: CatalogObservation; sources: SourceObservation[] }> {
  const observation: CatalogObservation = { catalog, checkedAt: new Date().toISOString(), status: "unavailable" };
  try {
    const res = await request(net, catalog, { headers: { accept: "application/linkset+json" } });
    if (!res.ok) {
      cancelBody(res);
      observation.status = res.status === 401 ? "authentication-required" : res.status === 403 ? "forbidden" : res.status === 429 ? "rate-limited" : "unavailable";
      return { observation, sources: [] };
    }
    const body = await readBody(res, 1024 * 1024) as any;
    // Invalid or incomplete lists are never treated as authoritative removal.
    if (!body || !Array.isArray(body.linkset) || body.linkset.length > ENVIRONMENT_SOURCE_LIMIT) {
      observation.status = "invalid"; return { observation, sources: [] };
    }
    const links: Array<{ relation: SourceObservation["relation"]; value: any }> = [];
    for (const entry of body.linkset) {
      if (!entry || typeof entry !== "object") throw new Error("invalid catalog");
      for (const relation of ["service-desc", "item"] as const) {
        if (entry[relation] === undefined) continue;
        if (!Array.isArray(entry[relation])) throw new Error("invalid catalog");
        for (const value of entry[relation]) {
          if (!value || typeof value.href !== "string" || links.length >= ENVIRONMENT_SOURCE_LIMIT) throw new Error("invalid catalog");
          links.push({ relation, value });
        }
      }
    }
    const digest = await sha256(JSON.stringify(body));
    observation.digest = digest;
    const sources: SourceObservation[] = [];
    for (const [index, { relation, value }] of links.entries()) {
      let source: string;
      try { source = safeUrl(value.href, res.url || catalog); }
      catch { source = `[invalid advertisement ${index}]`; }
      const media = typeof value.type === "string" ? value.type.split(";")[0].trim().toLowerCase() : "";
      const supported = relation === "service-desc" && ["", "application/json", "application/yaml", "text/yaml", "application/vnd.oai.openapi+json", "application/vnd.oai.openapi+yaml"].includes(media);
      let allowed = false;
      try { await checkUrl(net.policy, source); allowed = true; } catch { /* preserve a bounded, credential-free refusal */ }
      const candidate: SourceObservation = {
        source, catalog, relation, kind: supported ? "openapi" : undefined,
        status: !allowed ? "blocked" : supported ? "advertised" : "unsupported",
        observedAt: observation.checkedAt, advertisementDigest: digest,
        reachable: "unknown", authenticated: "unknown", authority: "not-assessed",
        credentials: allowed && net.auth.origins().includes(new URL(source).origin) ? "configured" : "absent", providers: [],
      };
      // Prefer a contract description over a duplicate item advertisement.
      const old = sources.findIndex(s => s.source === source);
      if (old < 0) sources.push(candidate);
      else if (candidate.kind && !sources[old].kind) sources[old] = candidate;
    }
    observation.status = "observed";
    return { observation, sources };
  } catch (error) {
    const message = String(error);
    observation.status = /blocked by .*policy/.test(message) ? "blocked" : /invalid catalog|body exceeds/.test(message) ? "invalid" : "unavailable";
    return { observation, sources: [] };
  }
}
