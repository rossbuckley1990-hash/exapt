// The platform reflector: RightClick X researching the machine it is running
// on. The same code finds different powers in different places: Cloudflare
// bindings (KV storage, Workers AI) at the edge, a workspace filesystem on a
// server, nothing extra in a browser tab. Whatever it finds becomes ordinary
// graph nodes that compose with everything else.

import type { Capability, Port, Reflection, SemType } from "../core/types.ts";

export type PlatformFn = (args: Record<string, any>) => Promise<unknown>;

export interface RuntimeInfo {
  name: "cloudflare-workers" | "deno" | "bun" | "node" | "browser" | "unknown";
  version?: string;
  features: string[];
  region?: string;
  country?: string;
}

export function detectRuntime(): RuntimeInfo {
  const g = globalThis as any;
  const features: string[] = [];
  if (typeof g.fetch === "function") features.push("fetch");
  if (g.crypto?.subtle) features.push("webcrypto");
  if (typeof g.WebSocket === "function") features.push("websocket");
  if (typeof g.caches === "object") features.push("cache-api");
  if (g.navigator?.userAgent === "Cloudflare-Workers") return { name: "cloudflare-workers", features };
  if (g.Deno?.version) return { name: "deno", version: g.Deno.version.deno, features: [...features, "fs", "env"] };
  if (g.Bun?.version) return { name: "bun", version: g.Bun.version, features: [...features, "fs", "env"] };
  if (g.process?.versions?.node) return { name: "node", version: g.process.versions.node, features: [...features, "fs", "env"] };
  if (typeof g.window === "object" && typeof g.document === "object") return { name: "browser", features: [...features, "dom"] };
  return { name: "unknown", features };
}

const port = (name: string, type: SemType, required = true): Port => ({ name, type, required });

export interface PlatformOptions {
  /** Cloudflare-style env bindings (KV namespaces, AI binding). */
  bindings?: Record<string, unknown>;
  /** Root directory for workspace file capabilities on server runtimes. */
  workspace?: string;
}

export async function platformReflection(info: RuntimeInfo, opts: PlatformOptions): Promise<{ reflection: Reflection; fns: Map<string, PlatformFn> }> {
  const fns = new Map<string, PlatformFn>();
  const capabilities: Capability[] = [];
  const providerId = `platform:${info.name}`;
  const add = (fn: string, c: Omit<Capability, "id" | "provider" | "source" | "invoke">, run: PlatformFn) => {
    fns.set(fn, run);
    capabilities.push({ ...c, id: `${providerId}:${fn}`, provider: providerId, source: "platform", invoke: { kind: "platform", fn } });
  };

  for (const [name, b] of Object.entries(opts.bindings ?? {})) {
    const binding = b as any;
    if (binding && typeof binding.get === "function" && typeof binding.put === "function" && typeof binding.list === "function") {
      add(`kv.${name}.get`, { title: `Read from ${name}`, description: `Read a value from the ${name} key-value store.`, inputs: [port("key", "id")], outputs: [port("", "text")], risk: "read", tags: ["kv", "storage", "read", name] }, async ({ key }) => (await binding.get(String(key))) ?? null);
      add(`kv.${name}.put`, { title: `Store in ${name}`, description: `Persist a text value in the ${name} key-value store at the edge.`, inputs: [port("key", "id"), port("value", "text")], outputs: [port("", "json"), port("key", "id")], risk: "write", tags: ["kv", "storage", "save", "persist", name] }, async ({ key, value }) => {
        await binding.put(String(key), String(value));
        return { key: String(key), stored: true };
      });
    } else if (binding && typeof binding.run === "function") {
      const model = "@cf/meta/llama-3.1-8b-instruct";
      add(`ai.${name}.generate`, { title: "Generate text (Workers AI)", description: `Run ${model} on the edge for a prompt.`, inputs: [port("prompt", "text")], outputs: [port("", "text")], risk: "external", tags: ["ai", "llm", "generate", "write", "summarize", "translate"] }, async ({ prompt }) => {
        const r = await binding.run(model, { prompt: String(prompt) });
        return r?.response ?? JSON.stringify(r);
      });
    }
  }

  if (opts.workspace && (info.name === "node" || info.name === "bun" || info.name === "deno")) {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const root = path.resolve(opts.workspace);
    // Paths are judged by where they really lead: a symlink inside the workspace that points
    // outside it is an escape, for reads and for writes alike.
    const within = (real: string, realRoot: string) => real === realRoot || real.startsWith(realRoot + path.sep);
    const inside = async (p: string, forWrite = false) => {
      const full = path.resolve(root, String(p));
      if (full !== root && !full.startsWith(root + path.sep)) throw new Error(`path escapes workspace: ${p}`);
      const realRoot = await fs.realpath(root);
      if (forWrite) {
        const link = await fs.lstat(full).catch(() => null);
        if (link?.isSymbolicLink()) throw new Error(`refusing to write through a symlink: ${p}`);
        // The nearest existing ancestor must really be inside the workspace.
        let dir = path.dirname(full);
        while (!(await fs.lstat(dir).catch(() => null))) dir = path.dirname(dir);
        if (!within(await fs.realpath(dir), realRoot)) throw new Error(`path escapes workspace: ${p}`);
        return full;
      }
      const real = await fs.realpath(full);
      if (!within(real, realRoot)) throw new Error(`path escapes workspace: ${p}`);
      return real;
    };
    add("fs.list", { title: "List workspace files", description: `List files in the workspace (${root}).`, inputs: [port("dir", "path", false)], outputs: [port("", "list:path")], risk: "read", tags: ["files", "list", "workspace"] }, async ({ dir }) => (await fs.readdir(await inside(dir ?? "."), { recursive: true })).map(String).slice(0, 1000));
    add("fs.read", { title: "Read workspace file", description: "Read a text file from the workspace.", inputs: [port("path", "path")], outputs: [port("", "text")], risk: "read", tags: ["files", "read", "workspace"] }, async ({ path: p }) => fs.readFile(await inside(p), "utf8"));
    add("fs.write", { title: "Write workspace file", description: "Write text to a file in the workspace.", inputs: [port("path", "path"), port("content", "text")], outputs: [port("", "json"), port("path", "path")], risk: "write", tags: ["files", "write", "save", "workspace"] }, async ({ path: p, content }) => {
      const full = await inside(p, true);
      await fs.mkdir(path.dirname(full), { recursive: true });
      // mkdir may have created directories; re-check before writing.
      await inside(p, true);
      await fs.writeFile(full, String(content));
      return { path: String(p), bytes: new TextEncoder().encode(String(content)).length };
    });
  }

  return {
    reflection: {
      provider: {
        id: providerId,
        title: `Platform: ${info.name}`,
        source: "platform",
        origin: info.name,
        learnedAt: new Date().toISOString(),
        capabilityIds: capabilities.map((c) => c.id),
        meta: { ...info, bindings: Object.keys(opts.bindings ?? {}), workspace: opts.workspace },
      },
      capabilities,
    },
    fns,
  };
}
