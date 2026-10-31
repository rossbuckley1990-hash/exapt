// The execution boundary for generated programs. Generated code is untrusted, so it never shares a
// process, a filesystem or a credential with EXAPT. Each run is a fresh disposable container:
//
//   no network; a read-only root; a size-limited noexec tmpfs; no host mounts of any kind (source
//   and input travel over stdin, so no path on this machine is reachable, including the home
//   directory and the Docker socket); all capabilities dropped; no privilege gain; an unprivileged
//   uid; kernel cgroup limits on memory, swap, processes and CPU; a timeout enforced both by this
//   process and inside the container; output capped by this process.
//
// Node's vm module, workers and prompts are not security boundaries and are not used as such.
// Where the boundary cannot be established and self-tested, execution is refused. There is no
// silent fallback. Docker Desktop on macOS adds a Linux VM between the container and the host.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";


import { pool, Refused, sha256 } from "../shared/index.ts";

export const IMAGE = "node@sha256:4b150b48b4116e2a22f2c39cc27025fbf4f153e2078fd3b14d159fdb5c7279da";
export const IMAGE_TAG = "node:22-bookworm-slim";

export interface Limits {
  timeoutMs: number;
  memoryMb: number;
  pids: number;
  cpus: number;
  tmpfsMb: number;
  maxOutputBytes: number;
}

export const DEFAULT_LIMITS: Limits = { timeoutMs: 8000, memoryMb: 256, pids: 32, cpus: 1, tmpfsMb: 32, maxOutputBytes: 8 * 1024 * 1024 };

export type RunStatus = "ok" | "threw" | "timeout" | "memory" | "output-limit" | "crash";

export interface RunResult {
  status: RunStatus;
  output?: string;
  /** Output bytes as base64, when the program returned bytes rather than text. */
  outputBase64?: string;
  error?: string;
  ms: number;
  /** Peak resident set reported inside the container, in KiB. Comparable, not attested. */
  rssKb?: number;
}

export interface RunRequest {
  source: string;
  input: string | Buffer;
  /** Verified capabilities the program may call: name to source. */
  libs?: Record<string, string>;
  limits?: Partial<Limits>;
}

export interface ExecutionBackend {
  readonly name: string;
  /** What this boundary enforces, stated for evidence and capability cards. */
  readonly enforces: string[];
  /** What it does not establish. */
  readonly notEstablished: string[];
  run(req: RunRequest): Promise<RunResult>;
}

const MARK = "@@EXAPT-RESULT@@";

// The constant in-container harness. It is not a boundary, only the calling convention.
const HARNESS = `
import fs from 'node:fs';
const env = JSON.parse(fs.readFileSync(0, 'utf8'));
fs.mkdirSync('/tmp/c', { recursive: true });
fs.writeFileSync('/tmp/c/program.mjs', env.source);
const report = (r) => process.stdout.write('\\n${MARK}' + JSON.stringify(r) + '\\n', () => process.exit(0));
const t0 = performance.now();
try {
  const lib = {};
  let i = 0;
  for (const [name, source] of Object.entries(env.libs ?? {})) {
    const file = '/tmp/c/lib' + (i++) + '.mjs';
    fs.writeFileSync(file, source);
    lib[name] = (await import(file)).transform;
  }
  const input = env.encoding === 'base64' ? Buffer.from(env.input, 'base64') : env.input;
  const mod = await import('/tmp/c/program.mjs');
  if (typeof mod.transform !== 'function') throw new Error('program does not export a function named transform');
  const out = await mod.transform(input, lib);
  const ms = performance.now() - t0;
  const rssKb = process.resourceUsage().maxRSS;
  if (out instanceof Uint8Array) report({ ok: true, outputBase64: Buffer.from(out).toString('base64'), ms, rssKb });
  else if (typeof out === 'string') report({ ok: true, output: out, ms, rssKb });
  else report({ ok: false, error: 'transform must return a string or bytes, got ' + (out === null ? 'null' : typeof out), ms, rssKb });
} catch (e) {
  report({ ok: false, error: String(e && e.message || e).slice(0, 800), ms: performance.now() - t0 });
}
`;

function dockerArgs(name: string, limits: Limits): string[] {
  const seconds = Math.ceil(limits.timeoutMs / 1000) + 1;
  return [
    "run", "--rm", "-i", "--init", "--name", name, "--label", "exapt.generated=1",
    "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", "65534:65534", "--workdir", "/tmp",
    "--memory", `${limits.memoryMb}m`, "--memory-swap", `${limits.memoryMb}m`, "--pids-limit", String(limits.pids), "--cpus", String(limits.cpus),
    "--ulimit", `cpu=${seconds}:${seconds}`, "--ulimit", "core=0", "--ulimit", "nofile=128:128",
    "--tmpfs", `/tmp:rw,noexec,nosuid,nodev,size=${limits.tmpfsMb}m`,
    IMAGE,
    "timeout", "-s", "KILL", String(seconds), "node", "--max-old-space-size=" + Math.max(32, limits.memoryMb - 48), "--input-type=module", "-e", HARNESS,
  ];
}

export class DockerBackend implements ExecutionBackend {
  readonly name = "docker";
  readonly enforces = [
    "no network (--network none)",
    "no host mounts: source and input arrive over stdin, so the home directory and the Docker socket are unreachable",
    "read-only root filesystem; writes only to a size-limited noexec tmpfs that disappears with the container",
    "all Linux capabilities dropped, no-new-privileges, unprivileged uid 65534",
    "no host environment variables are passed into the container",
    "hard cgroup limits on memory, swap, process count and CPU",
    "wall-clock timeout enforced by this process and inside the container; output capped by this process",
    "image pinned by content digest",
  ];
  readonly notEstablished = [
    "protection against a container-runtime or kernel escape",
    "a covert channel through timing or resource use",
    "attestation of the timing and memory figures, which are reported from inside the container",
  ];
  private ready: Promise<void> | undefined;

  private assertReady(): Promise<void> {
    return (this.ready ??= (async () => {
      const report = await selfTest(this);
      if (!report.ok) throw new Refused("sandbox-unverified", `execution boundary failed its self-test: ${report.failures.join("; ")}`, "Run `exapt doctor` and fix the listed containment failure.");
    })());
  }

  async run(req: RunRequest): Promise<RunResult> {
    await this.assertReady();
    return this.spawnRun(req);
  }

  /** Used directly by the self-test; everything else goes through run(). */
  spawnRun(req: RunRequest): Promise<RunResult> {
    const limits = { ...DEFAULT_LIMITS, ...req.limits };
    const name = `exapt-${randomBytes(6).toString("hex")}`;
    const envelope = JSON.stringify({
      source: req.source, libs: req.libs ?? {},
      encoding: typeof req.input === "string" ? "text" : "base64",
      input: typeof req.input === "string" ? req.input : req.input.toString("base64"),
    });
    const t0 = performance.now();
    return new Promise((done) => {
      const p = spawn("docker", dockerArgs(name, limits), { stdio: ["pipe", "pipe", "pipe"] });
      let out = Buffer.alloc(0);
      let err = "";
      let stopped: RunStatus | undefined;
      const stop = (why: RunStatus) => {
        stopped ??= why;
        spawn("docker", ["kill", name], { stdio: "ignore" }).on("error", () => {});
      };
      const timer = setTimeout(() => stop("timeout"), limits.timeoutMs + 1500);
      p.stdout.on("data", (d: Buffer) => {
        if (out.length + d.length > limits.maxOutputBytes) return stop("output-limit");
        out = Buffer.concat([out, d]);
      });
      p.stderr.on("data", (d: Buffer) => {
        if (err.length < 4000) err += d.toString();
      });
      p.stdin.on("error", () => {});
      p.stdin.end(envelope);
      p.on("error", (e) => {
        clearTimeout(timer);
        done({ status: "crash", error: `docker could not be started: ${e.message}`, ms: performance.now() - t0 });
      });
      p.on("close", (code) => {
        clearTimeout(timer);
        const ms = performance.now() - t0;
        if (stopped) return done({ status: stopped, error: stopped === "timeout" ? `exceeded ${limits.timeoutMs}ms` : `exceeded ${limits.maxOutputBytes} output bytes`, ms });
        const text = out.toString("utf8");
        const at = text.lastIndexOf(MARK);
        if (at < 0) {
          // 137 is SIGKILL: the cgroup OOM killer, or the in-container timeout.
          if (code === 137) return done({ status: /oom|memory/i.test(err) ? "memory" : ms > limits.timeoutMs ? "timeout" : "memory", error: "killed by the container's limits", ms });
          return done({ status: "crash", error: `no result (exit ${code}): ${err.slice(0, 300)}`, ms });
        }
        try {
          const r = JSON.parse(text.slice(at + MARK.length));
          if (r.ok) done({ status: "ok", ...(r.outputBase64 !== undefined ? { outputBase64: r.outputBase64 } : { output: r.output }), ms: r.ms, rssKb: r.rssKb });
          else done({ status: "threw", error: r.error, ms: r.ms, rssKb: r.rssKb });
        } catch {
          done({ status: "crash", error: "unreadable result", ms });
        }
      });
    });
  }
}

/** The check that decides whether generated code may run at all on this host. */
export function dockerStatus(): { available: boolean; imagePresent: boolean; detail: string; serverVersion?: string } {
  const v = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { encoding: "utf8", timeout: 8000 });
  if (v.error || v.status !== 0) return { available: false, imagePresent: false, detail: "Docker is not installed or its daemon is not running" };
  const img = spawnSync("docker", ["image", "inspect", IMAGE, "--format", "ok"], { encoding: "utf8", timeout: 8000 });
  return { available: true, imagePresent: img.status === 0, serverVersion: v.stdout.trim(), detail: img.status === 0 ? "ready" : `image ${IMAGE_TAG} at the pinned digest is not present` };
}

export function pullImage(): boolean {
  return spawnSync("docker", ["pull", IMAGE], { stdio: "inherit" }).status === 0;
}

export interface SelfTestReport {
  ok: boolean;
  checks: Array<{ name: string; passed: boolean; detail: string }>;
  failures: string[];
}

const probe = (body: string): string => `export async function transform() { ${body} }`;

/** Prove containment by attacking it, rather than by trusting the flags. */
export async function selfTest(backend: DockerBackend): Promise<SelfTestReport> {
  const status = dockerStatus();
  if (!status.available) return { ok: false, checks: [], failures: [status.detail] };
  if (!status.imagePresent) return { ok: false, checks: [], failures: [status.detail] };
  const cases: Array<{ name: string; source: string; expect: (r: RunResult) => boolean; limits?: Partial<Limits> }> = [
    { name: "harness runs a program", source: probe(`return 'alive';`), expect: (r) => r.output === "alive" },
    { name: "network is denied", source: probe(`try { await fetch('http://1.1.1.1', { signal: AbortSignal.timeout(1500) }); return 'reached'; } catch { return 'denied'; }`), expect: (r) => r.output === "denied" },
    { name: "root filesystem is read-only", source: probe(`const fs = await import('node:fs'); try { fs.writeFileSync('/etc/pwn', 'x'); return 'wrote'; } catch { return 'denied'; }`), expect: (r) => r.output === "denied" },
    { name: "no host paths are mounted", source: probe(`const fs = await import('node:fs'); return JSON.stringify(['/Users', '/home/ross', '/var/run/docker.sock', '/private'].filter((p) => fs.existsSync(p)));`), expect: (r) => r.output === "[]" },
    { name: "no ambient credentials", source: probe(`return JSON.stringify(Object.keys(process.env).filter((k) => /KEY|TOKEN|SECRET|PASS|ANTHROPIC|OPENAI|GITHUB/i.test(k)));`), expect: (r) => r.output === "[]" },
    { name: "unprivileged uid", source: probe(`return String(process.getuid());`), expect: (r) => r.output === "65534" },
    { name: "memory limit kills an allocation bomb", source: probe(`const a = []; for (;;) a.push(Buffer.alloc(8 * 1024 * 1024, 1));`), expect: (r) => ["memory", "crash", "threw"].includes(r.status), limits: { memoryMb: 96, timeoutMs: 8000 } },
    { name: "process limit stops a fork bomb", source: probe(`const { spawn } = await import('node:child_process'); let n = 0; try { for (let i = 0; i < 64; i++) { const c = spawn('sleep', ['3']); await new Promise((ok, no) => { c.on('spawn', ok); c.on('error', no); }); n++; } } catch {} return String(n);`), expect: (r) => r.status !== "ok" || Number(r.output) < 16, limits: { pids: 12, timeoutMs: 6000 } },
    { name: "timeout stops an infinite loop", source: probe(`for (;;) {}`), expect: (r) => r.status === "timeout" || r.status === "memory", limits: { timeoutMs: 1500 } },
    { name: "output cap stops a flood", source: probe(`const chunk = 'x'.repeat(65536); for (let i = 0; i < 4096; i++) await new Promise((ok) => process.stdout.write(chunk, ok)); return 'done';`), expect: (r) => r.status === "output-limit", limits: { maxOutputBytes: 1024 * 1024 } },
  ];
  const results = await pool(cases, 4, async (c) => {
    const r = await backend.spawnRun({ source: c.source, input: "", limits: c.limits });
    return { name: c.name, passed: c.expect(r), detail: `${r.status}${r.output !== undefined ? `: ${r.output.slice(0, 80)}` : ""}${r.error ? ` (${r.error.slice(0, 120)})` : ""}` };
  });
  const failures = results.filter((c) => !c.passed).map((c) => `${c.name}: ${c.detail}`);
  return { ok: failures.length === 0, checks: results, failures };
}

/** The operator's chosen boundary. Only Docker is accepted for generated code today. */
export function openBackend(env: NodeJS.ProcessEnv = process.env): ExecutionBackend {
  const choice = env.EXAPT_SANDBOX ?? "docker";
  if (choice !== "docker") throw new Refused("sandbox-unsupported", `EXAPT_SANDBOX=${choice} is not an accepted boundary for generated code`, "Unset it to use Docker. Generated code is refused rather than run with weaker containment.");
  return new DockerBackend();
}

/** Remove containers a crashed EXAPT left behind. */
export function reapOrphans(): number {
  const r = spawnSync("docker", ["ps", "-q", "--filter", "label=exapt.generated=1", "--filter", "status=running"], { encoding: "utf8", timeout: 8000 });
  const ids = (r.stdout ?? "").split("\n").filter(Boolean);
  if (ids.length) spawnSync("docker", ["kill", ...ids], { stdio: "ignore", timeout: 15000 });
  return ids.length;
}

export const sourceDigest = (source: string): string => sha256(source);
