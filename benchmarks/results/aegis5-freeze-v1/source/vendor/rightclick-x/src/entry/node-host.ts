// Server-runtime glue (Node, Bun, Deno): HTTP serving, stdio MCP, file state.

import type { RightClick, PersistedState, Store } from "../runtime.ts";
import { AsyncLocalStorage } from "node:async_hooks";
import { goalDefinitionDigest } from "../core/goal-identity.ts";
import { backupSuffix, decodeState, encodeState, FILE_STORE_CAS_REQUIREMENT, FILE_STORE_GOAL_LEASE_REQUIREMENT, migrationReplaces } from "../core/state-format.ts";
import { StateCommitUnknownError, StateConflictError } from "../core/state-conflict.ts";
import { handle, type JsonRpc } from "../interface/mcp-server.ts";

export type FetchHandler = (req: Request) => Promise<Response>;

export interface Served {
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Serve a fetch handler. Uses Bun.serve / Deno.serve natively, node:http otherwise. */
export async function serve(handler: FetchHandler, port = 8787, hostname = "127.0.0.1"): Promise<Served> {
  const g = globalThis as any;
  if (g.Bun?.serve) {
    const s = g.Bun.serve({ port, hostname, fetch: handler, idleTimeout: 0 });
    return { url: `http://${hostname}:${s.port}`, port: s.port, close: async () => s.stop(true) };
  }
  if (g.Deno?.serve) {
    const s = g.Deno.serve({ port, hostname, onListen() {} }, handler);
    return { url: `http://${hostname}:${s.addr.port}`, port: s.addr.port, close: () => s.shutdown() };
  }
  const http = await import("node:http");
  const server = http.createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      const body = chunks.length ? Buffer.concat(chunks) : undefined;
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(", ") : v);
      const request = new Request(`http://${req.headers.host ?? `${hostname}:${port}`}${req.url}`, {
        method: req.method,
        headers,
        body: body && req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) return res.end();
      const reader = response.body.getReader();
      req.on("close", () => reader.cancel().catch(() => {}));
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        res.write(value);
      }
      res.end();
    } catch (e) {
      if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
      res.end(String((e as Error)?.message ?? e));
    }
  });
  await new Promise<void>((r) => server.listen(port, hostname, r));
  const actual = (server.address() as { port: number }).port;
  return {
    url: `http://${hostname}:${actual}`,
    port: actual,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

/** MCP over stdio: newline-delimited JSON-RPC. Logs go to stderr only. */
export async function serveStdio(rc: RightClick): Promise<void> {
  const g = globalThis as any;
  const proc = g.process;
  let buf = "";
  proc.stdin.setEncoding("utf8");
  proc.stdin.on("data", async (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: JsonRpc | JsonRpc[];
      try {
        msg = JSON.parse(line);
      } catch {
        proc.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
        continue;
      }
      const msgs = Array.isArray(msg) ? msg : [msg];
      for (const m of msgs) {
        const out = await handle(rc, m);
        if (out) proc.stdout.write(JSON.stringify(out) + "\n");
      }
    }
  });
  await new Promise<void>((r) => proc.stdin.on("end", r));
  await rc.flush();
}

/** A shared, volatile state backend for runtimes within this Node process only.
 * Each runtime receives a private CAS view. Neither restarts, other processes,
 * nor independent backend objects share state. Do not use for cross-process authority. */
export class ProcessMemoryStore implements Store {
  private state: PersistedState | null = null;
  private version = 0;
  private owner: object | undefined;
  private readonly context = new AsyncLocalStorage<{ owner: object; active: boolean; pending: Set<Promise<unknown>>; failures: unknown[] }>();

  /** A store object itself is a factory; direct operations use an independent view. */
  private readonly direct = this.session();
  forRuntime(): Store { return this.session(); }
  load(): Promise<PersistedState | null> { return this.direct.load(); }
  save(state: PersistedState): Promise<void> { return this.direct.save(state); }
  withGoalLease<T>(pins: Array<{ slug: string; digest: string }>, invoke: () => Promise<T>): Promise<T> {
    return this.direct.withGoalLease!(pins, invoke);
  }

  private session(): Store {
    const owner = {};
    let seen: number | undefined;
    const validate = async (pins: Array<{ slug: string; digest: string }>) => {
      const state = this.state;
      if (!state) throw new StateConflictError("authoritative process-local goal state is unavailable");
      for (const pin of pins) {
        const matches = (state.published ?? []).filter(g => g.slug === pin.slug);
        if (matches.length !== 1 || !matches[0].revision || await goalDefinitionDigest(matches[0]) !== pin.digest)
          throw new StateConflictError(`saved goal ${pin.slug} is stale, revoked, or inconsistent`);
      }
    };
    return {
      load: async () => { seen = this.version; return this.state && structuredClone(this.state); },
      save: async state => {
        const scope = this.context.getStore();
        if (this.owner && !(scope?.active && scope.owner === owner && this.owner === owner))
          throw new StateConflictError("another runtime holds the process-local goal lease");
        if (seen !== this.version) throw new StateConflictError("process-local state changed; restart and reload before saving");
        // Clone before publication; callers cannot mutate authoritative state by alias.
        this.state = structuredClone(state);
        seen = ++this.version;
      },
      withGoalLease: async <T>(pins: Array<{ slug: string; digest: string }>, invoke: () => Promise<T>): Promise<T> => {
        const inherited = this.context.getStore();
        if (inherited?.active && inherited.owner === owner && this.owner === owner) {
          // Each admitted nested call has its own lifetime; it remains an
          // owner after its parent returns, but not after it has completed.
          const child = { owner, active: true, pending: inherited.pending, failures: inherited.failures };
          const task = (async () => { try { await validate(pins); return await this.context.run(child, invoke); } finally { child.active = false; } })();
          inherited.pending.add(task);
          void task.then(() => {}, error => { inherited.failures.push(error); });
          try { return await task; } finally { inherited.pending.delete(task); }
        }
        if (this.owner) throw new StateConflictError("another runtime holds the process-local goal lease");
        this.owner = owner;
        const scope = { owner, active: true, pending: new Set<Promise<unknown>>(), failures: [] as unknown[] };
        let invoked = false;
        try {
          await validate(pins);
          invoked = true;
          return await this.context.run(scope, invoke);
        } finally {
          // Never release while an admitted nested invocation can still dispatch.
          scope.active = false;
          while (scope.pending.size) await Promise.allSettled([...scope.pending]);
          this.owner = undefined;
          if (scope.failures.length && invoked) throw new Error("goal execution outcome unknown after an admitted nested failure; do not replay; inspect retained evidence", { cause: scope.failures[0] });
        }
      },
    };
  }
}

export class FileStore implements Store {
  private file: string;
  private tail: Promise<void> = Promise.resolve();
  private lastSave: Promise<void> = Promise.resolve();
  private leaseReserved = false;
  /** The file as loaded, held until a save has replaced it: if that save changes its format or
   *  inference version, these exact bytes are kept on disk first. */
  private loaded?: { value: unknown; bytes: Uint8Array };
  // Undefined means the file has never been observed, null means it was absent.
  private expected?: Uint8Array | null;
  /** Do not let a later queued save overwrite an uncertain committed snapshot. */
  private commitUnknown = false;
  private readonly leaseContext = new AsyncLocalStorage<{ active: boolean; held: boolean; pending: Set<Promise<unknown>>; failures: unknown[] }>();
  private onBackup?: (path: string) => void;
  constructor(file: string, opts: { onBackup?: (path: string) => void } = {}) {
    this.file = file;
    this.onBackup = opts.onBackup;
  }
  /** A symlink or multiply-linked file would allow different lock names to
   *  observe the same state inode and then diverge on atomic rename. */
  private async readStateBytes(): Promise<Uint8Array> {
    const fs = await import("node:fs/promises");
    const info = await fs.lstat(this.file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
      throw new StateConflictError("state path must be a singly linked regular file in a trusted directory");
    return fs.readFile(this.file);
  }
  async load(): Promise<PersistedState | null> {
    if (this.commitUnknown) throw new StateCommitUnknownError("open a fresh store and reload");
    let bytes: Uint8Array;
    try {
      bytes = await this.readStateBytes();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.expected = null; this.loaded = undefined; return null; }
      throw error;
    }
    const value = JSON.parse(new TextDecoder().decode(bytes));
    const state = decodeState(value);
    this.loaded = { value, bytes };
    this.expected = bytes;
    return state;
  }
  async save(state: PersistedState): Promise<void> {
    // Do not queue an unrelated save behind a lease: a later owner-scoped
    // runtime flush may itself be queued behind that save, causing deadlock.
    // The caller receives a conflict and can explicitly reconcile it.
    const inherited = this.leaseContext.getStore();
    const scope = inherited?.active ? inherited : undefined;
    if (this.leaseReserved && !scope)
      throw new StateConflictError("a local saved-goal lease is pending or active; retry the save explicitly after it completes");
    // Capture the caller's snapshot before yielding; later graph mutations must
    // not change an already requested save. A flush queues behind prior saves.
    const protectedState = state.version === 2 ? { ...state, requirements: [...new Set([...(state.requirements ?? []), FILE_STORE_CAS_REQUIREMENT, FILE_STORE_GOAL_LEASE_REQUIREMENT])] } : state;
    const content = encodeState(protectedState);
    const next = this.tail.then(() => this.write(content, protectedState, scope));
    if (scope) {
      scope.pending.add(next);
      void next.then(() => scope.pending.delete(next), () => scope.pending.delete(next));
    }
    this.lastSave = next;
    this.tail = next.catch(() => {});
    return next;
  }
  async withGoalLease<T>(pins: Array<{ slug: string; digest: string }>, invoke: () => Promise<T>): Promise<T> {
    if (this.commitUnknown) throw new StateCommitUnknownError("open a fresh store and reload");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const inherited = this.leaseContext.getStore();
    if (inherited?.active) {
      // Register synchronously before yielding, so an outer callback cannot
      // release the lock while an admitted nested invocation still runs.
      const child = { active: true, held: inherited.held, pending: inherited.pending, failures: inherited.failures };
      const task = (async () => { try { await this.assertGoalPins(pins); return await this.leaseContext.run(child, invoke); } finally { child.active = false; } })();
      inherited.pending.add(task);
      void task.then(() => {}, error => { inherited.failures.push(error); });
      try { return await task; } finally { inherited.pending.delete(task); }
    }
    if (this.leaseReserved) throw new StateConflictError("another local saved-goal lease is pending or active");
    // Reserve synchronously before waiting: a newly submitted save must not
    // slip between the existing save and acquisition of the filesystem lock.
    this.leaseReserved = true;
    try {
      await this.lastSave;
      if (this.commitUnknown) throw new StateCommitUnknownError("open a fresh store and reload");
      await fs.mkdir(path.dirname(this.file), { recursive: true });
      const lock = `${this.file}.lock`;
      try { await fs.mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StateConflictError("goal execution or publication holds the file lock");
        throw error;
      }
      const scope = { active: true, held: true, pending: new Set<Promise<unknown>>(), failures: [] as unknown[] };
      let invoked = false;
      try {
        await this.assertGoalPins(pins);
        invoked = true;
        return await this.leaseContext.run(scope, invoke);
      } finally {
        scope.active = false;
        while (scope.pending.size) await Promise.allSettled([...scope.pending]);
        let saveFailure: unknown;
        let saveFailed = false;
        try { await this.lastSave; } catch (error) { saveFailed = true; saveFailure = error; }
        scope.held = false;
        try { await fs.rmdir(lock); }
        catch (error) {
          if (invoked) throw new Error("goal execution outcome unknown after lease cleanup failure; do not replay; inspect retained evidence");
          throw error;
        }
        const failure = saveFailed ? saveFailure : scope.failures[0];
        if (saveFailed || scope.failures.length) {
          if (invoked) throw new Error(saveFailed ? "goal execution outcome unknown after persistence failure; do not replay; inspect retained evidence" : "goal execution outcome unknown after an admitted nested failure; do not replay; inspect retained evidence", { cause: failure });
          throw failure;
        }
      }
    } finally { this.leaseReserved = false; }
  }
  private async assertGoalPins(pins: Array<{ slug: string; digest: string }>): Promise<void> {
    let state: PersistedState;
    try { state = decodeState(JSON.parse(new TextDecoder().decode(await this.readStateBytes()))); }
    catch { throw new StateConflictError("authoritative goal state is unavailable or invalid"); }
    for (const pin of pins) {
      const matches = (state.published ?? []).filter(g => g.slug === pin.slug);
      if (matches.length !== 1 || !matches[0].revision || await goalDefinitionDigest(matches[0]) !== pin.digest)
        throw new StateConflictError(`saved goal ${pin.slug} is stale, revoked, or inconsistent`);
    }
  }
  private async write(content: string, state: PersistedState, scope?: { held: boolean }): Promise<void> {
    if (this.commitUnknown) throw new StateCommitUnknownError("open a fresh store and reload");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    // Cooperating writers serialize the read/compare/rename sequence. A lock left
    // by a crash is intentionally not stolen: an operator must investigate it.
    const lock = `${this.file}.lock`;
    // A save initiated inside the active leased goal shares that exact lease;
    // unrelated concurrent calls, and timers after its release, do not.
    const owned = scope?.held === true;
    try { if (!owned) await fs.mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new StateConflictError("another writer holds the file lock");
      throw error;
    }
    let renameAttempted = false;
    try {
    try {
      let current: Uint8Array | null;
      try { current = await this.readStateBytes(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") current = null; else throw error; }
      // An uninitialized adapter may create a new file, but must not overwrite an
      // existing snapshot it never observed. A stale snapshot must be reloaded.
      const expected = this.expected === undefined ? null : this.expected;
      const same = current === null ? expected === null : expected !== null && current.length === expected.length && current.every((b, i) => b === expected[i]);
      if (!same) throw new StateConflictError("persisted snapshot changed; restart and reload before saving");
      // Keep a byte-exact backup before replacing an older format.
      const replaced = this.loaded && migrationReplaces(this.loaded.value, state);
      let backup: string | undefined;
      if (replaced) {
        backup = `${this.file}${backupSuffix(replaced)}`;
        const handle = await fs.open(backup, "wx", 0o600);
        try {
          await handle.writeFile(this.loaded!.bytes);
          await handle.sync();
        } finally { await handle.close(); }
      }
      // Distinct staging paths avoid collisions; the lock and snapshot check above
      // provide the cooperating-writer protection.
      const tmp = `${this.file}.${process.pid}.${crypto.randomUUID()}.tmp`;
      const handle = await fs.open(tmp, "wx", 0o600);
      try {
        try { await handle.writeFile(content); }
        finally { await handle.close(); }
        renameAttempted = true;
        await fs.rename(tmp, this.file);
        this.expected = new TextEncoder().encode(content);
        this.loaded = undefined;
        if (backup) this.onBackup?.(backup);
      } finally {
        await fs.unlink(tmp).catch(error => { if (error.code !== "ENOENT") throw error; });
      }
    } finally { if (!owned) await fs.rmdir(lock); }
    } catch (error) {
      if (!renameAttempted) throw error;
      this.commitUnknown = true;
      throw new StateCommitUnknownError("commit was attempted; open a fresh store and reload");
    }
  }
}
