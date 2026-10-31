// Confined execution of local programs: the only way RightClick X runs a command-line program.
// No shell parses anything a caller or program supplies (argv only), no network, writes only into
// a fresh temporary directory that is deleted afterwards, no reads under user home directories
// except that directory, a scrubbed environment, and limits on wall time, CPU time, file size,
// open files and output. Memory/process count use a sampled watchdog, NOT a hard kernel bound:
// short peaks and non-resident/compressed memory may escape observation. Every run is its own process group, and the whole
// group is terminated when the program exits or exceeds a limit, so nothing it started outlives it.
// Where the OS offers no such sandbox, execution is refused ("unavailable"), never run unconfined.
//
// The operator may widen this by declaration (RCX_SANDBOX_READ / _READ_DENY / _WRITE / _PATH /
// _NET / _TIMEOUT_MS / _MEMORY_MB / _FILE_MB), never the agent and never a capability. Everything
// is deny-by-default and every widening is restated in `enforces`, so a capability card cannot
// claim more confinement than the run it describes actually had. Declaring a read root also grants
// stat — not listing, not contents — on the directories above it, because a root that cannot be
// path-resolved is unusable: see resolutionAncestors. A read-deny root may be declared
// before it exists, so a barrier can precede the data it conceals: see pendingDenyRoot.

import { validateFileNames } from "./cli-files.ts";

export interface SandboxLimits {
  timeoutMs: number;
  maxOutputBytes: number;
  /** Sampled resident-memory budget of the process group; not a hard allocation/footprint bound. */
  maxMemoryBytes: number;
  /** Processes alive at once in the run's process group. */
  maxProcesses: number;
  /** Largest file the program may write (RLIMIT_FSIZE). */
  maxFileBytes: number;
}

export type LimitHit = "time" | "cpu" | "memory" | "processes" | "output" | "file-size" | "supervision";

export interface SandboxRun {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
  durationMs: number;
  /** Files present in the working directory afterwards that were not given as inputs. */
  created: string[];
  /** The limit that stopped the run, if any. */
  limit?: LimitHit;
  /** The run's private working directory (already deleted); used to normalise outputs that name it. */
  workDir: string;
}

export const DEFAULT_LIMITS: SandboxLimits = { timeoutMs: 5000, maxOutputBytes: 1_000_000, maxMemoryBytes: 512 * 1024 * 1024, maxProcesses: 64, maxFileBytes: 16 * 1024 * 1024 };

/**
 * Operator-declared widening of the confinement, resolved once from the environment.
 *
 * The default profile is enough to *investigate* a command-line program but not to
 * *run* one: it cannot read a project directory or the interpreter that project
 * uses, cannot reach a network, and cannot outlive five seconds. That makes every
 * installed toolchain on the host unreachable, so the graph can describe software it
 * can never execute. Each relaxation here is opt-in, named by absolute path, and
 * reported in `enforces`, so a capability card never claims more confinement than
 * the run actually had. Declarations fail closed: a malformed root is an error,
 * never a silent fallback to a looser profile. A *missing read-deny* root is the one
 * exception and it fails closed too — see pendingDenyRoot.
 */
export interface SandboxPolicy {
  readRoots: string[];
  /** Subpaths of a read root that stay unreadable. An enforced barrier, not a promise. */
  readDenyRoots: string[];
  /** The subset of `readDenyRoots` that did not exist when the policy was resolved.
   *
   *  Kept apart so `enforces` can say so: a barrier over a path nothing has been
   *  written to yet is not evidence about any byte, and a capability card must not
   *  read as though it were. */
  readDenyPending?: string[];
  writeRoots: string[];
  pathDirs: string[];
  network: boolean;
  limits: SandboxLimits;
}

/** No operator declarations at all: the historical, fully confined profile. */
export const CONFINED_POLICY: SandboxPolicy = {
  readRoots: [],
  readDenyRoots: [],
  writeRoots: [],
  pathDirs: ["/usr/bin", "/bin"],
  network: false,
  limits: DEFAULT_LIMITS,
};

// Paths become sandbox-profile parameters and PATH entries, so a value that could
// terminate a profile clause or inject a separator is refused rather than escaped.
const SAFE_PATH = /^[A-Za-z0-9._+@/-]+$/;

function declaredRoots(value: string | undefined, what: string): string[] {
  const out: string[] = [];
  for (const raw of (value ?? "").split(":")) {
    const entry = raw.trim();
    if (!entry) continue;
    if (!entry.startsWith("/") || entry.includes("..") || !SAFE_PATH.test(entry)) {
      throw new Error(`RCX_SANDBOX_${what} refused: ${entry} is not an absolute, plain path`);
    }
    out.push(entry);
  }
  return out;
}

let policyProbe: Promise<SandboxPolicy> | undefined;

/**
 * Resolve a declared read-deny root that does not exist yet, against the longest
 * ancestor of it that does.
 *
 * `resolve()` refuses a missing path, which is right for a *read* root: a root that is
 * not there cannot be read, so the declaration is a mistake worth failing on. It is
 * wrong for a deny root, whose entire purpose is to be in place before the data it
 * conceals is written. No generator can create a directory and protect it in the same
 * step, so refusing leaves the operator exactly two choices — manufacture an empty
 * directory out-of-band, or let the concealed data be written unprotected and add the
 * barrier afterwards. The second is how a held-out answer key ends up readable during
 * the only period in which reading it does damage.
 *
 * The canonical prefix comes from realpath, so symlinks above the missing part are
 * resolved the same way they would be for an existing root; the missing components are
 * kept literally, because there is nothing to resolve them against. Residual, stated
 * rather than papered over: if the path is later created as a *symlink*, the barrier
 * covers that link's path and not its target.
 */
export function pendingDenyRoot(realpath: (p: string) => string, entry: string): string {
  const parts = entry.split("/").filter(Boolean);
  for (let i = parts.length - 1; i >= 1; i--) {
    const literal = `/${parts.slice(0, i).join("/")}`;
    let real: string;
    try {
      real = realpath(literal);
    } catch {
      continue;
    }
    return real + entry.slice(literal.length);
  }
  throw new Error(`RCX_SANDBOX_READ_DENY refused: no ancestor of ${entry} exists, so the barrier cannot be resolved`);
}

export function sandboxPolicy(): Promise<SandboxPolicy> {
  return (policyProbe ??= (async () => {
    const fs = await import("node:fs");
    const env: Record<string, string | undefined> = (globalThis as any).process?.env ?? {};
    const resolve = (entries: string[], what: string) =>
      entries.map((entry) => {
        let real: string;
        try {
          real = fs.realpathSync(entry);
        } catch {
          throw new Error(`RCX_SANDBOX_${what} refused: ${entry} does not exist`);
        }
        if (!SAFE_PATH.test(real)) throw new Error(`RCX_SANDBOX_${what} refused: ${real} is not a plain path`);
        return real;
      });
    const timeout = Number(env.RCX_SANDBOX_TIMEOUT_MS);
    const memoryMb = Number(env.RCX_SANDBOX_MEMORY_MB);
    const fileMb = Number(env.RCX_SANDBOX_FILE_MB);
    const positive = (n: number) => Number.isFinite(n) && Number.isInteger(n) && n > 0;
    const readRoots = resolve(declaredRoots(env.RCX_SANDBOX_READ, "READ"), "READ");
    const readDenyPending: string[] = [];
    const readDenyRoots = declaredRoots(env.RCX_SANDBOX_READ_DENY, "READ_DENY").map((entry) => {
      let real: string;
      try {
        real = fs.realpathSync(entry);
      } catch (error) {
        // Only absence may be recovered from. A permission error while resolving is not
        // a licence to deny some other path than the one the operator declared.
        if ((error as { code?: string }).code !== "ENOENT") {
          throw new Error(`RCX_SANDBOX_READ_DENY refused: ${entry} cannot be resolved (${String(error)})`);
        }
        real = pendingDenyRoot((p) => fs.realpathSync(p), entry);
        readDenyPending.push(real);
      }
      if (!SAFE_PATH.test(real)) throw new Error(`RCX_SANDBOX_READ_DENY refused: ${real} is not a plain path`);
      return real;
    });
    for (const deny of readDenyRoots) {
      if (!readRoots.some((root) => deny.startsWith(`${root}/`))) {
        // A barrier that bars nothing is worse than no barrier: it reads as
        // enforced while excluding no file at all.
        throw new Error(`RCX_SANDBOX_READ_DENY refused: ${deny} is not inside any RCX_SANDBOX_READ root, so it would exclude nothing`);
      }
    }
    return {
      readRoots,
      readDenyRoots,
      ...(readDenyPending.length ? { readDenyPending } : {}),
      writeRoots: resolve(declaredRoots(env.RCX_SANDBOX_WRITE, "WRITE"), "WRITE"),
      pathDirs: [...resolve(declaredRoots(env.RCX_SANDBOX_PATH, "PATH"), "PATH"), ...CONFINED_POLICY.pathDirs],
      network: env.RCX_SANDBOX_NET === "allow",
      limits: {
        ...CONFINED_POLICY.limits,
        ...(positive(timeout) ? { timeoutMs: Math.min(timeout, 900_000) } : {}),
        ...(positive(memoryMb) ? { maxMemoryBytes: memoryMb * 1024 * 1024 } : {}),
        // Simulators, compilers and encoders write intermediates far larger than the 16 MB
        // default: a 48-hour EPANET run needs 24 MB and fails with "cannot save results to
        // binary file" rather than degrading. Capped because ulimit -f is per file and an
        // unbounded declaration could fill the operator's disk from inside the sandbox.
        ...(positive(fileMb) ? { maxFileBytes: Math.min(fileMb, 4096) * 1024 * 1024 } : {}),
      },
    };
  })());
}

/** Home trees are denied wholesale; declared roots are re-allowed inside them. */
const HOME_DENY_ROOTS = ["/Users", "/home", "/root"];

/** Strict ancestors of every path the sandbox has to be able to resolve.
 *
 *  SBPL `subpath` re-allows a declared root but not the directories above it, while
 *  `realpath()` stats every component from `/`. Without this a program whose real path
 *  lives under a denied ancestor of an allowed root cannot start at all: Python resolves
 *  its own prefix during launch, so every host interpreter under /Users or /home dies
 *  with EPERM before executing a line, and the operator's declaration reads as ignored.
 *
 *  Metadata only. `stat` and path resolution succeed, but `readdir` and the contents of
 *  those directories stay denied, so the home tree still cannot be enumerated or read. */
function resolutionAncestors(paths: string[], denyRoots: string[]): string[] {
  const out = new Set<string>();
  for (const p of paths) {
    const parts = p.split("/").filter(Boolean);
    for (let i = 1; i < parts.length; i++) {
      const ancestor = `/${parts.slice(0, i).join("/")}`;
      // Only where the profile actually denies: an ancestor elsewhere is already
      // reachable under `(allow default)`, so naming it would widen nothing and
      // would only make the rule harder to audit.
      if (!HOME_DENY_ROOTS.some((h) => ancestor === h || ancestor.startsWith(`${h}/`))) continue;
      // Never widen a barrier: an ancestor that is a read-deny root, or inside one, stays denied.
      if (denyRoots.some((d) => ancestor === d || ancestor.startsWith(`${d}/`))) continue;
      out.add(ancestor);
    }
  }
  return [...out];
}

/** SBPL applies the last matching rule, so declared roots are appended after the
 *  blanket home-directory denial instead of narrowing it. */
export function macProfile(policy: SandboxPolicy, work: string): { text: string; params: string[] } {
  const params: string[] = [];
  const lines = [
    "(version 1)",
    "(allow default)",
    ...(policy.network ? [] : ["(deny network*)"]),
    "(deny file-write*)",
    `(allow file-write* (subpath (param "WORK")) (literal "/dev/null") (literal "/dev/tty"))`,
    `(deny file-read* ${HOME_DENY_ROOTS.map((h) => `(subpath "${h}")`).join(" ")})`,
    `(allow file-read* (subpath (param "WORK")))`,
  ];
  policy.readRoots.forEach((root, i) => {
    lines.push(`(allow file-read* (subpath (param "READ${i}")))`);
    params.push(`READ${i}=${root}`);
  });
  policy.readDenyRoots.forEach((root, i) => {
    lines.push(`(deny file-read* (subpath (param "READDENY${i}")))`);
    params.push(`READDENY${i}=${root}`);
  });
  policy.writeRoots.forEach((root, i) => {
    lines.push(`(allow file-write* (subpath (param "WRITE${i}")))`);
    params.push(`WRITE${i}=${root}`);
  });
  const ancestors = resolutionAncestors(
    [...policy.readRoots, ...policy.writeRoots, ...policy.pathDirs, work],
    policy.readDenyRoots,
  );
  if (ancestors.length) {
    // Last, so it wins over the blanket home denial, but only for stat: it can never
    // re-allow reading a directory's contents or a file's bytes.
    lines.push(`(allow file-read-metadata ${ancestors.map((_, i) => `(literal (param "ANC${i}"))`).join(" ")})`);
    ancestors.forEach((a, i) => params.push(`ANC${i}=${a}`));
  }
  return { text: lines.join("\n") + "\n", params };
}

// A constant script: it only sets resource limits, then replaces itself with the program. The
// program and its arguments arrive as positional parameters ("$0" "$@"), never as shell text.
const LIMITS_SCRIPT = 'ulimit -t "$RCX_CPU" 2>/dev/null; ulimit -f "$RCX_FSIZE" 2>/dev/null; ulimit -n 256 2>/dev/null; ulimit -c 0 2>/dev/null; exec "$0" "$@"';

export interface Sandbox {
  kind: "macos-sandbox-exec" | "linux-bwrap";
  /** The operator declarations this sandbox was built from. */
  policy: SandboxPolicy;
  /** What this sandbox enforces, stated for evidence and capability cards. */
  enforces: string[];
  forRevalidation?: () => Sandbox;
  /** purpose is host telemetry only; it grants no authority and changes no confinement. */
  run(bin: string, args: string[], opts?: { stdin?: string; files?: Record<string, string>; limits?: Partial<SandboxLimits>; purpose?: "execution" | "investigation" | "revalidation" | "agent-run" }): Promise<SandboxRun>;
}

let probed: Promise<Sandbox | null> | undefined;

/**
 * The sandbox available on this host, or null (then programs are not investigated or run). A
 * sandbox counts only if it actually starts here: bubblewrap without user namespaces (an
 * unprivileged container, a hardened kernel) is reported unavailable, not used.
 */
export function hostSandbox(): Promise<Sandbox | null> {
  return (probed ??= (async () => {
    const g = globalThis as any;
    if (!g.process?.versions?.node) return null;
    const fs = await import("node:fs");
    const policy = await sandboxPolicy();
    const candidates: Sandbox[] = [];
    if (g.process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) candidates.push(makeSandbox("macos-sandbox-exec", policy));
    for (const p of ["/usr/bin/bwrap", "/bin/bwrap"]) if (g.process.platform === "linux" && fs.existsSync(p)) candidates.push(makeSandbox("linux-bwrap", policy, p));
    for (const sb of candidates) {
      const r = await sb.run("/bin/echo", ["rcx-sandbox-probe"], { limits: { timeoutMs: 5000 } }).catch(() => null);
      if (r && r.code === 0 && r.stdout.trim() === "rcx-sandbox-probe") return sb;
    }
    return null;
  })());
}

/** Resident memory (bytes) and process count of one process group, or null when ps is unavailable. */
async function groupUsage(pgid: number): Promise<{ rss: number; procs: number } | null> {
  const { execFile } = await import("node:child_process");
  return new Promise((done) => {
    execFile("/bin/ps", ["-A", "-o", "pgid=,rss="], { timeout: 2000 }, (err, out) => {
      if (err) return done(null);
      if (!String(out).trim()) return done(null);
      let rss = 0;
      let procs = 0;
      for (const line of String(out).split("\n")) {
        if (!line.trim()) continue;
        const values = line.trim().split(/\s+/).map(Number);
        const [g, r] = values;
        if (values.length !== 2 || !Number.isSafeInteger(g) || g < 0 || !Number.isSafeInteger(r) || r < 0) return done(null);
        if (g === pgid) {
          procs++;
          rss += r * 1024;
        }
      }
      done({ rss, procs });
    });
  });
}

export function makeSandbox(kind: Sandbox["kind"], policy: SandboxPolicy, bwrap = ""): Sandbox {
  return {
    kind,
    policy,
    // Stated from the resolved policy, not from a constant: a capability card must
    // never claim more confinement than the run it describes actually had.
    enforces: [
      policy.network ? "NETWORK ALLOWED by operator declaration (RCX_SANDBOX_NET=allow)" : "no network",
      policy.writeRoots.length
        ? `writes only to a fresh temporary directory and the declared roots ${policy.writeRoots.join(", ")}`
        : "writes only to a fresh temporary directory",
      policy.readRoots.length
        ? `no reads under home directories except the declared roots ${policy.readRoots.join(", ")}` +
          (policy.readDenyRoots.length ? `; never readable: ${policy.readDenyRoots.join(", ")}` : "") +
          // Named separately: a barrier over a path that held nothing when it was
          // declared is a rule about the future, not an observation about any byte.
          (policy.readDenyPending?.length
            ? ` (of which declared before they existed, enforced from creation: ${policy.readDenyPending.join(", ")})`
            : "") +
          "; above a declared root only stat is permitted, so those directories cannot be listed or read"
        : "no reads under home directories",
      `PATH limited to ${policy.pathDirs.join(":")}`,
      "scrubbed environment",
      "argv only",
      `wall-time ${policy.limits.timeoutMs}ms, CPU-time, per-file ${Math.round(policy.limits.maxFileBytes / (1024 * 1024))}MB, open-file and output limits`,
      "sampled resident-memory/process-count watchdog; not a hard kernel bound; observer loss refuses results",
      "the run's whole process group is terminated when it ends",
    ],
    forRevalidation() {
      return makeSandbox(kind, {
        ...policy,
        network: false,
        writeRoots: [],
        limits: {
          timeoutMs: Math.min(policy.limits.timeoutMs, DEFAULT_LIMITS.timeoutMs),
          maxOutputBytes: Math.min(policy.limits.maxOutputBytes, DEFAULT_LIMITS.maxOutputBytes),
          maxMemoryBytes: Math.min(policy.limits.maxMemoryBytes, DEFAULT_LIMITS.maxMemoryBytes),
          maxProcesses: Math.min(policy.limits.maxProcesses, DEFAULT_LIMITS.maxProcesses),
          maxFileBytes: Math.min(policy.limits.maxFileBytes, DEFAULT_LIMITS.maxFileBytes),
        },
      }, bwrap);
    },
    async run(bin, args, opts = {}) {
      const { spawn } = await import("node:child_process");
      const fs = await import("node:fs");
      const os = await import("node:os");
      const path = await import("node:path");
      const limits = { ...policy.limits, ...opts.limits };
      validateFileNames(Object.keys(opts.files ?? {}));
      const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "rcx-sbx-")));
      const given = new Set<string>();
      try {
        for (const [name, content] of Object.entries(opts.files ?? {})) {
          // Exclusive creation also catches filesystem-specific aliases beyond our portable check.
          fs.writeFileSync(path.join(work, name), content, { flag: "wx" });
          given.add(name);
        }
      } catch (error) {
        fs.rmSync(work, { recursive: true, force: true });
        throw new Error(`cannot stage exact input files: ${String(error)} (HTTP 400 equivalent: nothing was run)`);
      }
      const wrapped = ["/bin/sh", "-c", LIMITS_SCRIPT, bin, ...args];
      let argv: string[];
      if (kind === "macos-sandbox-exec") {
        const profile = macProfile(policy, work);
        fs.writeFileSync(path.join(work, ".rcx.sb"), profile.text);
        given.add(".rcx.sb");
        argv = [
          "/usr/bin/sandbox-exec", "-f", path.join(work, ".rcx.sb"), "-D", `WORK=${work}`,
          ...profile.params.flatMap((p) => ["-D", p]),
          ...wrapped,
        ];
      } else {
        // bwrap applies bindings in order, so declared roots are bound after the
        // /home and /root tmpfs mounts that would otherwise hide them.
        argv = [
          bwrap, "--ro-bind", "/", "/", "--tmpfs", "/home", "--tmpfs", "/root",
          ...policy.readRoots.flatMap((r) => ["--ro-bind", r, r]),
          ...policy.readDenyRoots.flatMap((r) => ["--tmpfs", r]),
          ...policy.writeRoots.flatMap((r) => ["--bind", r, r]),
          "--bind", work, work, "--dev", "/dev", "--proc", "/proc",
          ...(policy.network
            ? ["--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup"]
            : ["--unshare-all"]),
          "--die-with-parent", "--chdir", work, ...wrapped,
        ];
      }
      const env = {
        PATH: policy.pathDirs.join(":"),
        HOME: work,
        TMPDIR: work,
        LANG: "C",
        LC_ALL: "C",
        TERM: "dumb",
        RCX_CPU: String(Math.max(1, Math.ceil(limits.timeoutMs / 1000))),
        RCX_FSIZE: String(Math.max(1, Math.floor(limits.maxFileBytes / 1024))),
      };
      const t0 = Date.now();
      return await new Promise<SandboxRun>((done) => {
        const p = spawn(argv[0], argv.slice(1), { cwd: work, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
        let out = Buffer.alloc(0);
        let err = Buffer.alloc(0);
        let truncated = false;
        let limit: LimitHit | undefined;
        let finished = false;
        let ending = false;
        const killGroup = () => {
          try {
            if (p.pid) process.kill(-p.pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        };
        const stop = (why: LimitHit) => {
          limit ??= why;
          if (!ending) killGroup();
        };
        const take = (which: "out" | "err") => (d: Buffer) => {
          const cur = which === "out" ? out : err;
          if (cur.length + d.length > limits.maxOutputBytes) {
            truncated = true;
            stop("output");
            return;
          }
          if (which === "out") out = Buffer.concat([out, d]);
          else err = Buffer.concat([err, d]);
        };
        p.stdout.on("data", take("out"));
        p.stderr.on("data", take("err"));
        p.stdin.on("error", () => {});
        p.stdin.end(opts.stdin ?? "");
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          stop("time");
        }, limits.timeoutMs);
        // Start immediately and allow one observation at a time. Failure is not
        // evidence of zero usage. This remains sampled supervision, not a kernel
        // memory boundary, even when every observation succeeds.
        let poll: Promise<void> | null = null;
        const checkResources = () => {
          if (finished || ending || !p.pid || poll) return;
          poll = groupUsage(p.pid).then(u => {
            if (finished) return;
            if (!u) stop("supervision");
            else if (u.rss > limits.maxMemoryBytes) stop("memory");
            else if (u.procs > limits.maxProcesses) stop("processes");
          }).catch(() => stop("supervision")).finally(() => { poll = null; });
        };
        const monitor = setInterval(checkResources, 100);
        checkResources();
        // The program exited: whatever it left running in its group goes with it.
        p.on("exit", (_code, signal) => {
          if (signal === "SIGXFSZ") limit ??= "file-size";
          if (signal === "SIGXCPU") limit ??= "cpu";
          killGroup();
        });
        const finish = async (code: number | null) => {
          if (finished || ending) return;
          ending = true;
          clearTimeout(timer);
          clearInterval(monitor);
          killGroup();
          // A fast child's exit must not publish success while an already
          // requested supervision check can still report that monitoring failed.
          await poll;
          finished = true;
          let created: string[] = [];
          try {
            created = fs.readdirSync(work).filter((f) => !given.has(f));
          } catch {
            /* gone */
          }
          fs.rmSync(work, { recursive: true, force: true });
          done({ code: limit === "supervision" ? -1 : code, stdout: limit === "supervision" ? "" : out.toString("utf8"), stderr: err.toString("utf8"), timedOut, truncated, durationMs: Date.now() - t0, created, workDir: work, ...(limit ? { limit } : {}) });
        };
        p.on("close", finish);
        p.on("error", () => finish(-1));
      });
    },
  };
}
