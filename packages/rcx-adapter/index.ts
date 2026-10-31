// The seam to the vendored RightClick X runtime. EXAPT keeps RightClick X's discovery, program
// investigation, typed graph, planner, receipts, execution policy and native program sandbox, and
// reaches them only through this module, so the vendored source stays byte-identical to upstream.
import fs from "node:fs";
import path from "node:path";
import { authorityFromEnv } from "../../vendor/rightclick-x/src/core/authority.ts";
import { CONFINED_POLICY, makeSandbox, type Sandbox, type SandboxPolicy } from "../../vendor/rightclick-x/src/core/sandbox.ts";
import { FileStore } from "../../vendor/rightclick-x/src/entry/node-host.ts";
import { RightClick } from "../../vendor/rightclick-x/src/index.ts";
import type { Investigation } from "../../vendor/rightclick-x/src/reflectors/cli.ts";
import { checkProgram } from "../../vendor/rightclick-x/src/core/programs.ts";
import type { BuiltinFn } from "../../vendor/rightclick-x/src/reflectors/builtins.ts";
import type { Capability, CliInvoke, Provider } from "../../vendor/rightclick-x/src/core/types.ts";
import { sha256 } from "../shared/index.ts";

export type { Capability, CliInvoke, Investigation, Sandbox };
export { RightClick };
export { TOOLS as RCX_TOOLS, dispatch as dispatchRcx } from "../../vendor/rightclick-x/src/interface/tools.ts";
export { createHandler as createRcxHandler } from "../../vendor/rightclick-x/src/interface/http.ts";
export { serve } from "../../vendor/rightclick-x/src/entry/node-host.ts";
export { VERSION as RCX_VERSION } from "../../vendor/rightclick-x/src/index.ts";
export { plan as rcxPlan } from "../../vendor/rightclick-x/src/core/planner.ts";
export { authorityFromEnv };

/** A learned program, addressed by the exact bytes that were investigated. */
export interface ProgramRef {
  capability: string;
  name: string;
  bin: string;
  sha256: string;
  args: string[];
  /** How the program receives its input: stdin, or a named file passed as an operand. */
  channel: "stdin" | { file: string };
}

export interface ToolRun {
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
  limit?: string;
}

const canonical = (p: string): string => fs.realpathSync(p);

/** The confinement for environment programs: RightClick X's native sandbox, narrowed to the
 *  operator's program roots. Generated code never runs here; it has its own boundary. */
function programPolicy(roots: string[]): SandboxPolicy {
  const home = process.env.HOME ?? "";
  const nodeDir = path.dirname(process.execPath);
  const readRoots = [...new Set(roots)];
  if (home && nodeDir.startsWith(home)) readRoots.push(path.dirname(nodeDir));
  return { ...CONFINED_POLICY, readRoots, pathDirs: [nodeDir, ...CONFINED_POLICY.pathDirs] };
}

async function nativeSandbox(roots: string[]): Promise<Sandbox | null> {
  const policy = programPolicy(roots);
  const candidates: Sandbox[] = [];
  if (process.platform === "darwin" && fs.existsSync("/usr/bin/sandbox-exec")) candidates.push(makeSandbox("macos-sandbox-exec", policy));
  for (const p of ["/usr/bin/bwrap", "/bin/bwrap"]) if (process.platform === "linux" && fs.existsSync(p)) candidates.push(makeSandbox("linux-bwrap", policy, p));
  for (const sb of candidates) {
    const r = await sb.run("/bin/echo", ["exapt-sandbox-probe"], { limits: { timeoutMs: 5000 } }).catch(() => null);
    if (r?.code === 0 && r.stdout.trim() === "exapt-sandbox-probe") return sb;
  }
  return null;
}

export class RcxHost {
  readonly rc: RightClick;
  readonly sandbox: Sandbox | null;
  /** Operator-authorised program entries (exact paths, or directories ending "/"). */
  readonly programs: string[];

  private constructor(rc: RightClick, sandbox: Sandbox | null, programs: string[]) {
    this.rc = rc;
    this.sandbox = sandbox;
    this.programs = programs;
  }

  /** Authority comes from the operator's configuration only. No agent-facing call reaches this. */
  static async open(opts: { home: string; programs: string[]; persist?: boolean }): Promise<RcxHost> {
    const entries = opts.programs.filter((p) => fs.existsSync(p)).map((p) => {
      const real = canonical(p);
      return fs.statSync(real).isDirectory() ? `${real}/` : real;
    });
    const roots = entries.map((e) => (e.endsWith("/") ? e.slice(0, -1) : path.dirname(e)));
    const sandbox = await nativeSandbox(roots);
    fs.mkdirSync(opts.home, { recursive: true });
    const rc = await RightClick.create({
      name: "exapt",
      sandbox,
      authority: { investigate: entries, execute: entries, destructive: "operator", shareEvidence: false },
      ...(opts.persist === false ? {} : { store: new FileStore(path.join(opts.home, "rcx-state.json")) }),
    });
    return new RcxHost(rc, sandbox, entries);
  }

  /** Investigate one authorised program with RightClick X's reflector. */
  async learn(bin: string): Promise<Capability[]> {
    const real = canonical(bin);
    await this.rc.learn({ source: `cli:${real}` });
    return this.rc.graph.list().filter((c) => c.invoke.kind === "cli" && c.invoke.bin === real);
  }

  investigation(bin: string): Investigation | undefined {
    const real = canonical(bin);
    return [...this.rc.investigations.values()].find((i) => i.program.bin === real);
  }

  /** Executable files directly inside the authorised directories, plus exact entries. */
  authorisedPrograms(): string[] {
    const out: string[] = [];
    for (const e of this.programs) {
      if (!e.endsWith("/")) out.push(e);
      else for (const f of fs.readdirSync(e).sort()) {
        const p = path.join(e, f);
        const st = fs.statSync(p);
        if (st.isFile() && st.mode & 0o100) out.push(p);
      }
    }
    return out;
  }

  programHash = (bin: string): string => sha256(fs.readFileSync(bin));

  /** Run a learned program in the native sandbox, refusing if its authority or bytes changed. */
  async runProgram(ref: ProgramRef, input: string | Buffer, opts: { pinned?: boolean; args?: string[]; timeoutMs?: number } = {}): Promise<ToolRun> {
    if (!this.sandbox) throw new Error("no native program sandbox on this host: environment programs are not run");
    const check = await checkProgram(ref.bin, this.programs);
    if (!check.ok) throw new Error(check.reason);
    if (opts.pinned !== false && this.programHash(ref.bin) !== ref.sha256) throw new ProgramChanged(ref);
    const args = [...ref.args, ...(opts.args ?? [])];
    // Bytes pass through unchanged: the sandbox's stream and file writers both accept a Buffer.
    const data = input as string;
    const files = ref.channel === "stdin" ? undefined : { [ref.channel.file]: data };
    const r = await this.sandbox.run(ref.bin, ref.channel === "stdin" ? args : [...args, ref.channel.file], { stdin: ref.channel === "stdin" ? data : "", files, limits: { timeoutMs: opts.timeoutMs ?? 5000 }, purpose: "execution" });
    return { ok: r.code === 0 && !r.limit, code: r.code, stdout: r.stdout, stderr: r.stderr, ms: r.durationMs, ...(r.limit ? { limit: r.limit } : {}) };
  }

  /** The program's documentation, read in its sandbox. Untrusted data, never instructions. */
  async readDocs(bin: string): Promise<string> {
    if (!this.sandbox) return "";
    for (const flag of ["--help", "-h", "help"]) {
      const r = await this.sandbox.run(bin, [flag], { limits: { timeoutMs: 3000 }, purpose: "investigation" }).catch(() => null);
      const text = `${r?.stdout ?? ""}${r?.stderr ?? ""}`.trim();
      if (text.length > 20 && (r?.code === 0 || /usage/i.test(text))) return text.slice(0, 20_000);
    }
    return "";
  }

  /** Give RightClick X the interface its generic probes could not reach, as evidence-backed CLI
   *  capability it runs under its own authority checks, sandbox and receipts. */
  registerMined(ref: ProgramRef, contract: { docs: string; claims: Array<{ claim: string }>; input: unknown; output: unknown }): void {
    const description = contract.docs.split("\n").find((l) => l.trim() && !/^usage/i.test(l.trim()))?.trim() ?? ref.name;
    const cap: Capability = {
      id: ref.capability, title: `${ref.name} (contract mined by EXAPT)`, description: description.slice(0, 200), provider: `exapt:mined`, source: "cli",
      inputs: [{ name: "input", type: "text", required: true, anyText: true, description: "Content the mined contract established this program accepts" }],
      outputs: [{ name: "", type: "text", required: true }], risk: "read", tags: [ref.name, "exapt-mined"],
      invoke: { kind: "cli", bin: ref.bin, args: ref.channel === "stdin" ? ref.args : [...ref.args, { input: "input" }], ...(ref.channel === "stdin" ? { stdin: "input" } : {}), okExit: [0], output: "text", sha256: ref.sha256 },
    };
    this.rc.graph.addCapability(cap, { id: "exapt:mined", title: "Contracts mined by EXAPT", source: "cli", origin: "exapt", learnedAt: new Date().toISOString() });
  }

  /** Make a retained EXAPT capability a real operation of the RightClick X graph, so context_run,
   *  context_compose and context_graph reach it like any other. RightClick X has no public hook for
   *  host-supplied functions; its builtin table is the narrow seam, pinned by test/vendor.test.ts. */
  registerOperation(cap: Capability, fn: BuiltinFn, provider: Omit<Provider, "capabilityIds">): void {
    const table = (this.rc as unknown as { builtins: Map<string, BuiltinFn> }).builtins;
    if (!(table instanceof Map)) throw new Error("vendored RightClick X no longer exposes its builtin table");
    table.set((cap.invoke as { fn: string }).fn, fn);
    this.rc.graph.addCapability(cap, provider);
    this.rc.persist();
  }

  /** Remove a retained operation so nothing can route through it. */
  retireOperation(id: string): void {
    const cap = this.rc.graph.get(id);
    if (!cap) return;
    this.rc.graph.capabilities.delete(id);
    const p = this.rc.graph.providers.get(cap.provider);
    if (p) p.capabilityIds = p.capabilityIds.filter((c) => c !== id);
    this.rc.graph.emit("capability.retired", { id, title: cap.title });
    this.rc.graph.relink();
    this.rc.persist();
  }
}

export class ProgramChanged extends Error {
  readonly program: ProgramRef;
  constructor(ref: ProgramRef) {
    super(`${ref.name} changed since it was pinned (expected sha256 ${ref.sha256.slice(0, 12)})`);
    this.program = ref;
  }
}
