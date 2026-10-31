// Engine A: the capability universe. RightClick X's graph knows what operations exist and how they
// are typed. This overlays what experiments established about each one, which capabilities EXAPT
// created, which transformations are known to be missing, and how far each is trusted. The graph is
// generative: a missing edge is a first-class node with a status, a specification and a ranking,
// and it becomes an executable operation only by passing through the experimental gates.
import path from "node:path";
import { RcxHost, type Capability, type CliInvoke, type ProgramRef } from "../rcx-adapter/index.ts";
import { pool, readJson, writeJson } from "../shared/index.ts";
import { mineContract, type DocOption } from "./miner.ts";
import { reprLabel } from "./repr.ts";
import type { CapabilityNode, CapabilityStatus, EvidenceLevel, Tool, ToolContract } from "./types.ts";

export * from "./repr.ts";
export * from "./types.ts";
export * from "./miner.ts";

export interface MissingNode {
  id: string;
  title: string;
  from: string;
  to: string;
  status: CapabilityStatus;
  rank: number;
  goal: string;
}

export interface GeneratedNodeInfo {
  id: string;
  version: number;
  status: CapabilityStatus;
  title: string;
  level: EvidenceLevel;
  from: string;
  to: string;
  oracles: string[];
  dependencies: Array<{ id: string; pin?: string }>;
  limitations: string[];
}

/** Verb prefixes RightClick X found (a dispatcher's subcommands); each is its own operation. */
function verbsOf(caps: Capability[]): string[][] {
  const out = new Map<string, string[]>();
  for (const cap of caps) {
    const inv = cap.invoke as CliInvoke;
    const verb: string[] = [];
    for (const a of inv.args) {
      if (typeof a !== "string" || a.startsWith("-")) break;
      verb.push(a);
    }
    if (verb.length) out.set(verb.join(" "), verb);
  }
  return [...out.values()].slice(0, 24);
}

export class Universe {
  readonly host: RcxHost;
  readonly tools = new Map<string, Tool>();
  readonly missing = new Map<string, MissingNode>();
  readonly generated = new Map<string, GeneratedNodeInfo>();
  private readonly contractDir: string;

  constructor(host: RcxHost, home: string) {
    this.host = host;
    this.contractDir = path.join(home, "contracts");
  }

  private programTool(ref: ProgramRef, contract: ToolContract): Tool {
    return {
      id: ref.capability, name: ref.name, kind: "program", ref, contract,
      run: async (input, opts) => this.host.runProgram(ref, input, opts),
    };
  }

  /** Learn every authorised program with RightClick X, then mine its contract. RightClick X's
   *  investigation supplies the identity, the documented options and the subcommands; the miner
   *  establishes what the program actually reads, which generic probes cannot reach for a strict
   *  format. Contracts are keyed by program bytes: an unchanged program is not re-investigated. */
  async discover(opts: { seeds?: string[]; refresh?: boolean } = {}): Promise<{ programs: number; learned: string[]; unusable: string[] }> {
    const learned: string[] = [];
    const unusable: string[] = [];
    const pending: Array<{ ref: ProgramRef; docs: string; options: DocOption[] }> = [];
    const bins = this.host.authorisedPrograms();
    await pool(bins, 4, async (bin) => {
      const caps = await this.host.learn(bin);
      const docs = await this.host.readDocs(bin);
      const options = this.host.investigation(bin)?.options ?? [];
      const name = path.basename(bin);
      const base = { name, bin, sha256: this.host.programHash(bin), channel: "stdin" as const };
      pending.push({ ref: { ...base, capability: `cli:${name}:mined`, args: [] }, docs, options });
      for (const verb of verbsOf(caps)) pending.push({ ref: { ...base, capability: `cli:${name}:${verb.join("-")}:mined`, name: `${name} ${verb.join(" ")}`, args: verb }, docs, options });
    });
    pending.sort((a, b) => a.ref.capability.localeCompare(b.ref.capability));
    // Two passes: what one program writes can be the positive sample another's docs did not give.
    const mined = new Map<string, ToolContract>();
    const seeds = [...(opts.seeds ?? [])];
    for (let pass = 0; pass < 2; pass++) {
      for (const { ref, docs, options } of pending) {
        if (mined.get(ref.capability)?.input) continue;
        const file = path.join(this.contractDir, `${ref.sha256}-${ref.args.join("_").replace(/\W/g, "_")}.json`);
        const cached = !opts.refresh && pass === 0 ? readJson<ToolContract & { channel?: ProgramRef["channel"] }>(file) : undefined;
        if (cached?.input) {
          ref.channel = cached.channel ?? "stdin";
          mined.set(ref.capability, cached);
          if (cached.output?.example) seeds.push(cached.output.example);
          continue;
        }
        let contract = await mineContract(ref.capability, ref.name, docs, (input, o) => this.host.runProgram(ref, input, o), { seeds, options });
        if (!contract.input) {
          const viaFile: ProgramRef = { ...ref, channel: { file: "input.txt" } };
          const second = await mineContract(ref.capability, ref.name, docs, (input, o) => this.host.runProgram(viaFile, input, o), { seeds, options });
          if (second.input) {
            ref.channel = viaFile.channel;
            contract = second;
          }
        }
        mined.set(ref.capability, contract);
        if (contract.input) {
          writeJson(file, { ...contract, channel: ref.channel });
          if (contract.output?.example) seeds.push(contract.output.example);
        }
      }
    }
    for (const { ref } of pending) {
      const contract = mined.get(ref.capability)!;
      if (ref.args.length && !contract.input) continue;
      this.tools.set(ref.capability, this.programTool(ref, contract));
      (contract.input ? learned : unusable).push(ref.capability);
      if (contract.input) this.host.registerMined(ref, contract);
    }
    return { programs: bins.length, learned, unusable };
  }

  /** Find a tool by capability id or program name. */
  tool(name: string): Tool | undefined {
    return this.tools.get(name) ?? [...this.tools.values()].find((t) => t.name === name);
  }

  usable(): Tool[] {
    return [...this.tools.values()].filter((t) => t.contract.input);
  }

  addGenerated(tool: Tool, info: GeneratedNodeInfo): void {
    if (info.status === "verified-within-scope") this.tools.set(tool.id, tool);
    else this.tools.delete(tool.id);
    this.generated.set(info.id, info);
    if (info.status !== "verified-within-scope") return;
    for (const [id, m] of this.missing) if (m.from === info.from && m.to === info.to) this.missing.delete(id);
  }

  removeGenerated(id: string): void {
    this.tools.delete(id);
  }

  noteMissing(nodes: MissingNode[]): void {
    for (const n of nodes) this.missing.set(n.id, n);
  }

  /** Every capability as a structured node, whatever produced it. */
  nodes(): CapabilityNode[] {
    const rc = this.host.rc;
    const out: CapabilityNode[] = [];
    for (const c of rc.graph.list()) {
      if (this.generated.has(c.id)) continue;
      const t = this.tools.get(c.id);
      const e = rc.ledger.get(c.id);
      const hasEvidence = !!t?.contract.input;
      out.push({
        id: c.id, version: 1, status: "existing", title: c.title, description: c.description.slice(0, 200), source: c.source, provider: c.provider,
        inputs: c.inputs.slice(0, 6).map((p, i) => ({ name: p.name, semantic: p.type, required: p.required, ...(i === 0 && t?.contract.input ? { repr: reprLabel(t.contract.input.repr) } : {}) })),
        outputs: c.outputs.slice(0, 6).map((p, i) => ({ name: p.name, semantic: p.type, ...(i === 0 && t?.contract.output ? { repr: reprLabel(t.contract.output.repr) } : {}) })),
        preconditions: t?.contract.input?.requiredFields.map((f) => `input carries ${f}`) ?? [],
        effects: { risk: c.risk, network: c.source !== "cli" && c.source !== "builtin", writes: c.source === "cli" ? "sandbox temporary directory only" : "none declared" },
        dependencies: t?.ref ? [{ id: t.ref.bin, pin: t.ref.sha256 }] : [],
        ...(t?.contract.behaviour ? { behaviour: t.contract.behaviour } : {}),
        verification: { available: hasEvidence },
        restrictions: c.tags.filter((x) => ["direct-only", "unsupported"].includes(x)),
        history: { runs: e?.runs ?? 0, ok: e?.ok ?? 0, failed: e?.failed ?? 0 },
      });
    }
    for (const g of this.generated.values()) {
      const e = rc.ledger.get(g.id);
      out.push({
        id: g.id, version: g.version, status: g.status, title: g.title, description: g.limitations[0] ?? "", source: "exapt", provider: "exapt:vault",
        inputs: [{ name: "input", semantic: "text", required: true, repr: g.from }], outputs: [{ name: "", semantic: "text", repr: g.to }],
        preconditions: [`input is ${g.from}`], effects: { risk: "read", network: false, writes: "none" }, dependencies: g.dependencies,
        verification: { available: true, level: g.level, oracles: g.oracles }, restrictions: [], history: { runs: e?.runs ?? 0, ok: e?.ok ?? 0, failed: e?.failed ?? 0 },
      });
    }
    for (const m of this.missing.values()) {
      out.push({
        id: m.id, version: 0, status: m.status, title: m.title, description: `Missing transformation for goal ${m.goal}`, source: "exapt", provider: "exapt:gap",
        inputs: [{ name: "input", semantic: "text", required: true, repr: m.from }], outputs: [{ name: "", semantic: "text", repr: m.to }],
        preconditions: [], effects: { risk: "read", network: false, writes: "none" }, dependencies: [], verification: { available: false }, restrictions: ["not executable"], history: { runs: 0, ok: 0, failed: 0 },
      });
    }
    return out;
  }

  search(query: string, opts: { status?: CapabilityStatus; limit?: number } = {}): CapabilityNode[] {
    const q = query.toLowerCase().split(/\s+/).filter(Boolean);
    const all = this.nodes().filter((n) => !opts.status || n.status === opts.status);
    const scored = all.map((n) => {
      const hay = `${n.id} ${n.title} ${n.description} ${n.inputs.map((p) => p.repr ?? p.semantic).join(" ")} ${n.outputs.map((p) => p.repr ?? p.semantic).join(" ")}`.toLowerCase();
      return { n, score: q.filter((w) => hay.includes(w)).length };
    });
    return scored.filter((s) => !q.length || s.score > 0).sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 20).map((s) => s.n);
  }

  /** Edges the Lab draws: observed representation flow, not lexical type matches. */
  flow(): { edges: Array<{ from: string; to: string; via: string; status: CapabilityStatus }> } {
    const edges: Array<{ from: string; to: string; via: string; status: CapabilityStatus }> = [];
    for (const t of this.tools.values()) {
      if (t.contract.input && t.contract.output) edges.push({ from: reprLabel(t.contract.input.repr), to: reprLabel(t.contract.output.repr), via: t.id, status: t.kind === "generated" ? "verified-within-scope" : "existing" });
    }
    for (const m of this.missing.values()) edges.push({ from: m.from, to: m.to, via: m.id, status: m.status });
    return { edges };
  }
}

