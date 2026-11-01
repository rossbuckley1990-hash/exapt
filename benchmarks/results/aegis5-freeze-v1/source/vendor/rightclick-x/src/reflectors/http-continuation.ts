// A deliberately narrow HTTP profile: 202 status resource(s), then 303 to a
// result representation. A 200 monitor is not a completion signal. No inferred
// body-state vocabulary, arbitrary URL probing, write replay or repair.
import type { Capability, Port } from "../core/types.ts";
import { sha256, stableStringify } from "../core/ledger.ts";
import { isSensitiveName } from "../core/secrets.ts";
import { cancelBody, readBody, request, TransportRefused, type Net } from "./net.ts";

export interface HttpContinuationOptions { maxRequests?: number; timeoutMs?: number }
export interface HttpContinuationEvidence {
  profile: "http-202-303";
  stopped: "result" | "disabled" | "no-location" | "unknown-target" | "changed-contract" | "denied" | "rate-limited" | "budget" | "cancelled" | "unavailable" | "monitor-response" | "unsupported-status" | "checkpoint-unavailable";
  requests: Array<{ capability: string; contractDigest: string; actionDigest: string; status?: number }>;
}
export type ContinuationPolicy = { maxRequests: number; timeoutMs: number };
export function continuationPolicy(opts?: HttpContinuationOptions | false): ContinuationPolicy {
  if (opts === false) return { maxRequests: 0, timeoutMs: 1 };
  const maxRequests = opts?.maxRequests ?? 4, timeoutMs = opts?.timeoutMs ?? 20_000;
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 8 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error("invalid HTTP continuation budget: 1..8 requests, 1..30000ms");
  }
  return { maxRequests, timeoutMs };
}

/** Snapshot before dispatch: a response cannot introduce its own execution route. */
export function continuationTargets(cap: Capability, graph: Capability[]) {
  const candidates = graph.filter(c => c.provider === cap.provider && c.risk === "read" && c.invoke.kind === "http" &&
    c.invoke.method === "GET" && !c.invoke.entry);
  // Refuse an oversized routing set rather than taking a misleading subset.
  if (candidates.length > 128) return [];
  return candidates.map(c => ({ cap: structuredClone(c), signature: contractIdentity(c) }));
}
type Target = ReturnType<typeof continuationTargets>[number];
/** Stored routing evidence, never credentials, a grant, or the original write. */
export interface HttpContinuationCursor {
  version: 1;
  origin: string;
  url: string;
  result: boolean;
  notBefore: number;
  used: number;
  targets: Array<{ id: string; digest: string }>;
}
export function validHttpCursor(c: HttpContinuationCursor): boolean {
  try {
    const url = new URL(c.url), origin = new URL(c.origin);
    return c.version === 1 && ["http:", "https:"].includes(url.protocol) && origin.origin === c.origin &&
      url.origin === c.origin && !url.username && !url.password && !url.hash && c.url.length <= 4096 &&
      typeof c.result === "boolean" && Number.isFinite(c.notBefore) && c.notBefore >= 0 &&
      Number.isInteger(c.used) && c.used >= 0 && c.used <= 32 && Array.isArray(c.targets) &&
      c.targets.length > 0 && c.targets.length <= 128 && new Set(c.targets.map(t => t.id)).size === c.targets.length &&
      c.targets.every(t => typeof t.id === "string" && t.id.length <= 512 && /^[a-f0-9]{64}$/.test(t.digest));
  } catch { return false; }
}
export async function httpContractDigest(c: Capability): Promise<string> { return sha256(contractIdentity(c)); }
// Exact local comparison, including risk/provider. This is not an authority
// signature or proof. Use the existing receipt digest only for recorded evidence.
function contractIdentity(c: Capability) {
  // Schemes are learned annotations, not declarations or changes to an action.
  // A successful step may add them to any port while its retained plan runs.
  // Preserve every other port field and the complete invocation in the pin.
  const declared = ({ schemes, ...port }: Port) => port;
  return stableStringify({ id: c.id, provider: c.provider, risk: c.risk, inputs: c.inputs.map(declared),
    outputs: c.outputs.filter(p => !p.observed).map(declared), invoke: c.invoke, ...(c.links?.length ? { links: c.links } : {}) });
}

/** Match the transport route without reinterpreting a string as another resource identity. */
function routeArgs(cap: Capability, url: URL): Record<string, string> | undefined {
  const inv = cap.invoke;
  if (inv.kind !== "http" || inv.multiSegment?.length) return;
  const base = new URL(inv.url);
  if (base.origin !== url.origin || base.search || base.hash) return;
  const from = base.pathname.split("/"), to = url.pathname.split("/");
  if (from.length !== to.length) return;
  const args: Record<string, string> = Object.create(null);
  for (let i = 0; i < from.length; i++) {
    // URL serialisation escapes template braces.
    const param = /^\{([^{}]+)\}$/.exec(decodeURIComponent(from[i]));
    if (param && inv.pathParams.includes(param[1])) {
      if (!to[i] || args[param[1]] !== undefined) return;
      args[param[1]] = decodeURIComponent(to[i]);
      if (args[param[1]].includes("/")) return;
    } else if (from[i] !== to[i]) return;
  }
  for (const [k, v] of url.searchParams) {
    if (args[k] !== undefined || isSensitiveName(k) ||
        !inv.queryParams.includes(k) && !Object.hasOwn(inv.constants ?? {}, k)) return;
    if (Object.hasOwn(inv.constants ?? {}, k) && inv.constants![k] !== v) return;
    args[k] = v;
  }
  if (Object.entries(inv.constants ?? {}).some(([k, v]) => args[k] !== v) ||
      cap.inputs.some(p => p.required && args[p.name] === undefined)) return;
  return args;
}

function delay(res: Response): number {
  const value = res.headers.get("retry-after");
  if (!value) return 100;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  // Date.parse also accepts non-HTTP strings such as "0.5". Do not turn an
  // invalid retry instruction into immediate polling. Obsolete date forms
  // are conservatively unsupported by this bounded profile.
  if (!/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(value)) return Infinity;
  const date = Date.parse(value);
  return Number.isFinite(date) && new Date(date).toUTCString() === value ? Math.max(0, date - Date.now()) : Infinity;
}
async function wait(ms: number, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!ms) return;
  await new Promise<void>((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export async function followHttp202(opts: {
  response: Response; url: string; targets: Target[]; net: Net; policy: ContinuationPolicy;
  current: (id: string) => Capability | undefined;
  authorize: (cap: Capability, args: Record<string, string>) => void;
  signal?: AbortSignal;
  resume?: HttpContinuationCursor;
  checkpoint?: (cursor: HttpContinuationCursor | null) => Promise<void>;
}): Promise<{ evidence: HttpContinuationEvidence; output?: unknown }> {
  const evidence: HttpContinuationEvidence = { profile: "http-202-303", stopped: "disabled", requests: [] };
  const save = async (cursor: HttpContinuationCursor | null) => {
    try { await opts.checkpoint?.(cursor); return true; }
    catch { return false; }
  };
  const stop = async (reason: HttpContinuationEvidence["stopped"], res?: Response) => {
    if (res) cancelBody(res);
    // An unsupported response is not evidence for replaying the prior GET later.
    if (["no-location", "unknown-target", "monitor-response", "unsupported-status"].includes(reason) && !await save(null)) reason = "checkpoint-unavailable";
    evidence.stopped = reason;
    return { evidence };
  };
  let res = opts.response, url = opts.url, result = false;
  const origin = new URL(url).origin, deadline = Date.now() + opts.policy.timeoutMs;
  if (!opts.policy.maxRequests) return stop("disabled", res);
  let targets = opts.targets;
  if (opts.resume) {
    if (!validHttpCursor(opts.resume) || opts.resume.origin !== origin) return stop("unknown-target", res);
    targets = targets.filter(t => opts.resume!.targets.some(old => old.id === t.cap.id));
    if (targets.length !== opts.resume.targets.length) return stop("changed-contract", res);
    for (const t of targets) if (await sha256(t.signature) !== opts.resume.targets.find(old => old.id === t.cap.id)!.digest) return stop("changed-contract", res);
  }
  const recorded = await Promise.all(targets.map(async t => ({ id: t.cap.id, digest: await sha256(t.signature) })));
  const used = opts.resume?.used ?? 0;
  // The initial transport may already have followed a redirect. This profile
  // does not guess a continuation context for that different resource.
  if (res.url && res.url !== url) return stop("unknown-target", res);
  for (let i = 0; i <= opts.policy.maxRequests; i++) {
    const location = res.headers.get("location");
    if (!location && (i === 0 || res.status === 303)) return stop("no-location", res);
    let next: URL, match: Array<{ target: Target; args: Record<string, string> }>;
    try {
      next = new URL(location ?? url, url);
      if (next.origin !== origin || next.username || next.password || next.hash || next.href.length > 4096) return stop("unknown-target", res);
      match = targets.flatMap(target => {
        const args = routeArgs(target.cap, next);
        return args ? [{ target, args }] : [];
      });
    } catch { return stop("unknown-target", res); }
    if (match.length !== 1) return stop("unknown-target", res);
    const { target, args } = match[0];
    const pause = i === 0 && opts.resume ? Math.max(0, opts.resume.notBefore - Date.now()) : delay(res);
    if (!Number.isFinite(pause)) {
      if (!await save(null)) return stop("checkpoint-unavailable", res);
      return stop("budget", res);
    }
    result = res.status === 303;
    const cursor: HttpContinuationCursor = { version: 1, origin, url: next.href, result,
      notBefore: Date.now() + pause, used: used + i, targets: recorded };
    // Persist acceptance/progress before waiting, and reserve the read attempt
    // before dispatch. A crash may repeat only this read under fresh authority.
    if (!await save(cursor)) return stop("checkpoint-unavailable", res);
    if (opts.signal?.aborted) return stop("cancelled", res);
    if (i === opts.policy.maxRequests || cursor.used >= 32 || cursor.notBefore >= deadline) return stop("budget", res);
    cancelBody(res);
    try { await wait(pause, opts.signal); }
    catch { return stop("cancelled"); }
    const observation: HttpContinuationEvidence["requests"][number] = {
      capability: target.cap.id, contractDigest: await sha256(target.signature),
      actionDigest: await sha256(JSON.stringify({ method: "GET", url: next.href })),
    };
    // Hashing yields: recheck authority and the contract after it, immediately
    // before transport dispatch. Independent transport enforcement is still required.
    const current = opts.current(target.cap.id);
    if (!current || contractIdentity(current) !== target.signature) return stop("changed-contract");
    try { opts.authorize(current, args); }
    catch { return stop("denied"); }
    if (opts.signal?.aborted) return stop("cancelled");
    if (Date.now() >= deadline) return stop("budget");
    if (!await save({ ...cursor, used: cursor.used + 1 })) return stop("checkpoint-unavailable");
    // Persistence yields too: no authority/contract check may be stale at dispatch.
    const latest = opts.current(target.cap.id);
    if (!latest || contractIdentity(latest) !== target.signature) return stop("changed-contract");
    try { opts.authorize(latest, args); }
    catch { return stop("denied"); }
    if (opts.signal?.aborted) return stop("cancelled");
    if (Date.now() >= deadline) return stop("budget");
    evidence.requests.push(observation);
    try {
      // No caller headers, content-negotiation retry, automatic redirects or
      // initial action replay. The normal origin credential broker is used.
      res = await request({ ...opts.net, timeoutMs: Math.min(opts.net.timeoutMs, deadline - Date.now()) },
        next.href, { method: "GET", headers: { accept: "application/json" }, redirect: "manual", signal: opts.signal });
      observation.status = res.status;
      url = next.href;
      if (res.status === 200) {
        if (!result) return stop("monitor-response", res);
        const output = await readBody(res, 16 * 1024 * 1024);
        if (output === "" || output === undefined) return stop("unsupported-status");
        const stopped = await stop("result");
        if (stopped.evidence.stopped !== "result") return stopped;
        return { evidence, output };
      }
      if (res.status === 401 || res.status === 403) return stop("denied", res);
      if (res.status === 429) {
        const backoff = delay(res);
        if (!await save(Number.isFinite(backoff) ? { ...cursor, used: cursor.used + 1, notBefore: Date.now() + backoff } : null)) return stop("checkpoint-unavailable", res);
        return stop("rate-limited", res);
      }
      if (res.status >= 500 || res.status === 404 || res.status === 410) return stop("unavailable", res);
      if (res.status !== 202 && res.status !== 303) return stop("unsupported-status", res);
    } catch (error) {
      const denied = error instanceof TransportRefused || /^blocked by (network|egress) policy/.test(String((error as Error)?.message));
      return stop(opts.signal?.aborted ? "cancelled" : denied ? "denied" : "unavailable");
    }
  }
  return stop("budget", res);
}
