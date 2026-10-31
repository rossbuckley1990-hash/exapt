// Networking shared by every reflector and executor.
//
// Credentials are origin-pinned: a header configured for https://api.a.com is
// attached only to requests whose origin is exactly that, so a reflected
// capability (or a redirect) can never carry a key to some other host.

import type { FetchLike, TransportContext, TransportRefusal } from "../core/types.ts";

/** Trusted host adapters can distinguish a boundary denial from transport failure.
 * This marker only stops work; it cannot authorize anything or attest a grant. */
export class TransportRefused extends Error {
  readonly refusal: TransportRefusal;
  constructor(reason: string, capability?: string, runs: string[] = []) {
    super(`blocked by execution boundary: ${reason}`);
    this.name = "TransportRefused";
    this.refusal = { reason, capability, runs };
  }
}

/** A standard authentication/authorization denial stops execution, without
 * treating the response as a signed proof or interpreting arbitrary body text. */
export function refuseDeniedResponse(res: Response): void {
  if (res.status === 401 || res.status === 403) {
    cancelBody(res);
    throw new TransportRefused(`HTTP ${res.status}: authentication or authorization refused`);
  }
}

export class Authority {
  private byOrigin = new Map<string, Record<string, string>>();

  set(originOrUrl: string, headers: Record<string, string>): void {
    this.byOrigin.set(new URL(originOrUrl).origin, headers);
  }

  headersFor(url: string): Record<string, string> {
    try {
      return this.byOrigin.get(new URL(url).origin) ?? {};
    } catch {
      return {};
    }
  }

  origins(): string[] {
    return [...this.byOrigin.keys()];
  }

  /** A non-reversible fingerprint per origin, to notice when credentials change. */
  async fingerprints(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (const [origin, headers] of this.byOrigin) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(headers)));
      out[origin] = [...new Uint8Array(buf)].slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
    }
    return out;
  }

  /**
   * Load from RCX_AUTH, a JSON object of origin -> header value or header map:
   *   {"https://api.example.com": "Bearer abc", "https://x.dev": {"X-Key": "k"}}
   */
  loadEnv(raw: string | undefined): void {
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, string | Record<string, string>>;
    for (const [origin, v] of Object.entries(parsed)) {
      this.set(origin, typeof v === "string" ? { Authorization: v } : v);
    }
  }
}

export interface NetworkPolicy {
  /** Refuse private, loopback, link-local and metadata addresses (SSRF protection). */
  blockPrivate: boolean;
  /** Hosts or origins allowed even when private, e.g. "localhost:8080" or "http://10.0.0.5". */
  allow?: string[];
  /** Hosts always refused. */
  deny?: string[];
  /** Egress allowlist (a caller's policy): only these origins, on every request and redirect hop. */
  origins?: string[];
}

export interface Net {
  fetch: FetchLike;
  auth: Authority;
  timeoutMs: number;
  policy?: NetworkPolicy;
  /** Owning execution only. Never serialized into the HTTP request. */
  execution?: Omit<TransportContext, "requestId">;
}

/** Bound contract acquisition without limiting ordinary finite execution outputs. */
export const DISCOVERY_BODY_LIMIT = 16 * 1024 * 1024;

const responseDeadlines = new WeakMap<Response, { deadline: number; controller: AbortController; signal: AbortSignal; error: Error }>();

export function isEventStream(res: Response): boolean {
  return res.headers.get("content-type")?.split(";")[0].trim().toLowerCase() === "text/event-stream";
}

/** Start disposal immediately; a transport's cleanup promise must not hold up discovery. */
export function cancelBody(res: Response): void {
  void res.body?.cancel().catch(() => {});
  responseDeadlines.get(res)?.controller.abort(new Error("response body discarded"));
}

/** Read within the original request deadline, including adapters whose reads ignore abort. */
export async function* bodyChunks(res: Response, maxBytes = Infinity): AsyncGenerator<Uint8Array> {
  if (!res.body) return;
  const context = responseDeadlines.get(res);
  const reader = res.body.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let rejectRead: ((reason: unknown) => void) | undefined;
  let complete = false;
  let size = 0;
  if (context) {
    onAbort = () => rejectRead?.(context.signal.reason);
    context.signal.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(() => context.controller.abort(context.error), Math.max(0, context.deadline - Date.now()));
  }
  try {
    while (true) {
      if (context?.signal.aborted) throw context.signal.reason;
      if (context && Date.now() >= context.deadline) throw context.error;
      // Keep only the current read's abort handler, not one pending race per chunk.
      const { done, value } = await new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => {
        rejectRead = reject;
        reader.read().then(resolve, reject);
      });
      rejectRead = undefined;
      if (done) { complete = true; return; }
      size += value.byteLength;
      if (size > maxBytes) throw new Error(`response body exceeds ${maxBytes} bytes`);
      yield value;
    }
  } finally {
    clearTimeout(timer);
    rejectRead = undefined;
    if (onAbort) context!.signal.removeEventListener("abort", onAbort);
    if (!complete) {
      void reader.cancel().catch(() => {});
      context?.controller.abort(new Error("response body no longer needed"));
    }
    reader.releaseLock();
  }
}

export async function readText(res: Response, maxBytes = Infinity): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  for await (const chunk of bodyChunks(res, maxBytes)) text += decoder.decode(chunk, { stream: true });
  return text + decoder.decode();
}

const METADATA_HOSTS = new Set(["metadata.google.internal", "metadata", "169.254.169.254", "fd00:ec2::254"]);

export function isPrivateAddress(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local") || METADATA_HOSTS.has(h)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(":")) {
    if (h === "::1" || h === "::") return true;
    if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
    if (mapped) return isPrivateAddress(mapped[1]);
  }
  return false;
}

/** Throws if the URL is not allowed by the network policy. Resolves hostnames on server runtimes. */
export async function checkUrl(policy: NetworkPolicy | undefined, raw: string): Promise<void> {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error(`blocked by network policy: ${u.protocol} URLs are not allowed`);
  if (!policy) return;
  if (policy.origins && !policy.origins.includes(u.origin)) throw new Error(`blocked by egress policy: ${u.origin} is not an approved origin`);
  const matches = (list?: string[]) => (list ?? []).some((x) => x === u.host || x === u.hostname || x === u.origin);
  if (matches(policy.deny)) throw new Error(`blocked by network policy: ${u.host} is denied`);
  if (!policy.blockPrivate || matches(policy.allow)) return;
  if (isPrivateAddress(u.hostname)) throw new Error(`blocked by network policy: ${u.hostname} is a private or metadata address`);
  // DNS can point a public-looking name at a private address; check what it resolves to.
  const g = globalThis as any;
  if (g.process?.versions?.node && !/^[\d.]+$|:/.test(u.hostname)) {
    try {
      const dns = await import("node:dns/promises");
      const addrs = await dns.lookup(u.hostname, { all: true });
      if (addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`blocked by network policy: ${u.hostname} resolves to a private address`);
    } catch (e) {
      if (String((e as Error).message).startsWith("blocked")) throw e;
    }
  }
}

/**
 * Some servers fail content negotiation when Accept lists several media types
 * (HTTP 406, or a 5xx error page) yet answer the first type alone. For safe
 * methods only, retry once with just the first listed type.
 */
export async function request(net: Net, url: string, init: RequestInit = {}): Promise<Response> {
  const res = await requestOnce(net, url, init);
  const method = (init.method ?? "GET").toUpperCase();
  const accept = new Headers(init.headers).get("accept") ?? "";
  const first = accept.split(",")[0].split(";")[0].trim();
  if ((method === "GET" || method === "HEAD") && accept.includes(",") && first && first !== "*/*" && (res.status === 406 || res.status >= 500)) {
    cancelBody(res);
    const headers = new Headers(init.headers);
    headers.set("accept", first);
    return requestOnce(net, url, { ...init, headers });
  }
  return res;
}

/** Request headers that carry no credential and may follow a redirect to another origin. */
const CROSS_ORIGIN_SAFE = new Set(["accept", "accept-language", "content-language", "user-agent"]);

async function requestOnce(net: Net, url: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const [k, v] of Object.entries(net.auth.headersFor(url))) if (!headers.has(k)) headers.set(k, v);
  if (!headers.has("user-agent")) headers.set("user-agent", "rightclick-x/0.1 (+https://github.com/rossbuckley1990-hash/rightclick)");
  await checkUrl(net.policy, url);
  const ctrl = new AbortController();
  const error = new Error(`timeout after ${net.timeoutMs}ms: ${url}`);
  const deadline = Date.now() + net.timeoutMs;
  const signal = init.signal ? AbortSignal.any([ctrl.signal, init.signal]) : ctrl.signal;
  const timer = setTimeout(() => ctrl.abort(error), net.timeoutMs);
  const track = (res: Response) => {
    responseDeadlines.set(res, { deadline, controller: ctrl, signal, error });
    return res;
  };
  try {
    // Manual redirects. A caller's headers (credentials of any name: Authorization, Cookie,
    // Proxy-Authorization, X-Api-Key, X-Session-Token, ...) never leave the original origin.
    // Once a redirect has left it, the chain is tainted: every later hop, even one back to the
    // original origin at a path a third party chose, gets only content-negotiation headers plus
    // the operator's credentials pinned to that hop's own origin. A request body is never sent
    // to another origin (307/308 across origins is not followed).
    const origin0 = new URL(url).origin;
    const caller = new Headers(init.headers);
    const userAgent = headers.get("user-agent")!;
    let tainted = false;
    let method = (init.method ?? "GET").toUpperCase();
    let body = init.body;
    const context = () => net.execution ? Object.freeze({ ...net.execution, requestId: crypto.randomUUID() }) : undefined;
    let res = await net.fetch(url, { ...init, headers, signal, redirect: "manual" }, context());
    if (init.redirect === "manual") return track(res);
    let hops = 0;
    while (res.status >= 300 && res.status < 400 && res.headers.get("location") && hops++ < 5) {
      const next = new URL(res.headers.get("location")!, url).toString();
      try { await checkUrl(net.policy, next); }
      catch (e) { cancelBody(res); throw e; }
      const nextOrigin = new URL(next).origin;
      // Carry the current request forward. Once 303 discards a body, later hops
      // must never restore the original POST/body, including on another origin.
      if (res.status === 303 && method !== "HEAD") method = "GET";
      if (method === "GET" || method === "HEAD") body = undefined;
      const carriesBody = body != null;
      if (carriesBody && nextOrigin !== new URL(url).origin) return track(res);
      if (nextOrigin !== origin0) tainted = true;
      const h = new Headers();
      for (const [k, v] of caller) {
        if (body == null && init.body != null && ["content-type", "content-length", "transfer-encoding"].includes(k.toLowerCase())) continue;
        if (!tainted || CROSS_ORIGIN_SAFE.has(k.toLowerCase()) || (carriesBody && k.toLowerCase() === "content-type")) h.set(k, v);
      }
      if (!h.has("user-agent")) h.set("user-agent", userAgent);
      for (const [k, v] of Object.entries(net.auth.headersFor(next))) h.set(k, v);
      cancelBody(res);
      res = await net.fetch(next, { ...init, method, body, headers: h, signal, redirect: "manual" }, context());
      url = next;
    }
    return track(res);
  } finally {
    clearTimeout(timer);
  }
}

export async function readBody(res: Response, maxBytes = Infinity): Promise<unknown> {
  const ct = res.headers.get("content-type") ?? "";
  const text = await readText(res, maxBytes);
  if (ct.includes("json") || /^\s*[{[]/.test(text)) {
    try {
      return JSON.parse(text);
    } catch {
      /* fall through */
    }
  }
  return text;
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "x"
  );
}
