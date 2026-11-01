// Edge entry: `export default { fetch }`. Deploys as-is to Cloudflare Workers
// (wrangler.toml), and the same module works for Deno Deploy, Bun, and any
// platform that accepts a module exporting a fetch handler.
//
// Environment (Workers vars/secrets, or process env elsewhere):
//   RCX_TOKEN    bearer token; without it the API stays locked on public hosts
//   RCX_SOURCES  comma-separated URLs to learn at cold start
//   RCX_AUTH     JSON {origin: "Bearer ..."} credentials, origin-pinned
//   RCX_NAME     instance name shown to peers
//   RCX_STATE    (binding) KV namespace holding a state to load, read-only (persist via the Durable Object entry)
//   any other KV / AI bindings become platform capabilities automatically

import { authorityFromEnv } from "../core/authority.ts";
import { decodeState } from "../core/state-format.ts";
import { createHandler } from "../interface/http.ts";
import { Authority } from "../reflectors/net.ts";
import { environmentOptions } from "../reflectors/environment.ts";
import { RightClick, type PersistedState, type Store } from "../runtime.ts";

type Env = Record<string, any>;

let instance: Promise<{ rc: RightClick; handler: (r: Request) => Promise<Response> }> | null = null;

/** Why Workers KV is read and never written. */
const KV_READ_ONLY = "Workers KV is eventually consistent, allows one write per second per key and has no atomic operations, so this Worker's many isolates cannot share it as one writer; persist state through the Durable Object entry (src/entry/durable.ts)";

/**
 * A state read from Workers KV, never written. Cloudflare's documented pattern is to route a key's
 * writes through one Durable Object and read it from KV elsewhere; the KV value can be seeded from
 * that deployment or by the operator. A legacy value loads and is migrated in memory only.
 */
export class KvStore implements Store {
  readonly readOnly = KV_READ_ONLY;
  private kv: any;
  constructor(kv: any) {
    this.kv = kv;
  }
  async load(): Promise<PersistedState | null> {
    const text = await this.kv.get("rcx-state", "text");
    return text == null ? null : decodeState(JSON.parse(text));
  }
  async save(_state: PersistedState): Promise<void> {
    throw new Error(`KV state is read-only: ${KV_READ_ONLY}`);
  }
}

async function boot(env: Env) {
  const auth = new Authority();
  auth.loadEnv(env.RCX_AUTH);
  const bindings: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(env)) if (v && typeof v === "object" && k !== "RCX_STATE") bindings[k] = v;
  const rc = await RightClick.create({
    name: env.RCX_NAME ?? "rightclick-x-edge",
    auth,
    bindings,
    store: env.RCX_STATE ? new KvStore(env.RCX_STATE) : undefined,
    authority: authorityFromEnv(env as Record<string, unknown>),
    environment: environmentOptions(env.RCX_ENVIRONMENT),
  });
  const sources = String(env.RCX_SOURCES ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s) => ![...rc.graph.providers.values()].some((p) => p.origin === s));
  if (sources.length) await rc.learn({ sources });
  return { rc, handler: createHandler(rc, { token: env.RCX_TOKEN }) };
}

export default {
  async fetch(req: Request, env: Env = {}, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    instance ??= boot(env).catch((e) => {
      instance = null;
      throw e;
    });
    const { rc, handler } = await instance;
    const cf = (req as any).cf;
    if (cf) rc.observeLocation(cf.colo, cf.country);
    const res = await handler(req);
    ctx?.waitUntil(rc.flush());
    return res;
  },
};
