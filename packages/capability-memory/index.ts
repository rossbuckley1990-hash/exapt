// Engine E: capability memory. What is retained is a portable, versioned operation, not an answer
// or a transcript: executable bytes, the behavioural contract, dependency pins, evidence, failures,
// limitations and the means to check all of it again. A future agent needs none of the conversation
// that created it. Authority does not travel: a definition arriving from elsewhere can do nothing
// here until this host has reproduced its checks under its own policy.
import fs from "node:fs";
import path from "node:path";
import { IMAGE } from "../execution/index.ts";
import type { BehaviouralContract, TestCase } from "../experiment-engine/index.ts";
import type { CapabilityStatus, EvidenceLevel } from "../capability-universe/index.ts";
import { digest, newId, readJson, sha256, stable, writeAtomic, writeJson } from "../shared/index.ts";
import type { EvidenceReport } from "../verification/index.ts";

export interface ProgramDependency {
  kind: "program";
  role: "upstream" | "consumer" | "oracle";
  capability: string;
  name: string;
  sha256: string;
  behaviour: string;
}

export interface CapabilityDependency {
  kind: "capability";
  id: string;
  version: number;
  sha256: string;
}

export type Dependency = ProgramDependency | CapabilityDependency;

/** The observed output of the consumer on a conformance output: a behaviour pin. */
export interface ConsumerWitness {
  caseId: string;
  outputDigest: string;
}

export interface CapabilityManifest {
  format: "exapt/capability@1";
  id: string;
  version: number;
  status: CapabilityStatus;
  title: string;
  purpose: string;
  inputs: Array<{ name: string; representation: string; semantic: string }>;
  outputs: Array<{ name: string; representation: string; semantic: string }>;
  artefact: { sha256: string; language: "javascript-esm"; entry: "transform"; bytes: number };
  contract: BehaviouralContract;
  dependencies: Dependency[];
  environment: { runtime: string; image: string; backend: string };
  permissions: { network: false; filesystem: "none"; risk: "read" };
  evidence: EvidenceReport;
  limitations: string[];
  counterexamples: Array<{ problem: string; input: string }>;
  rejected: Array<{ producer: string; rejectedAt: string; reason: string }>;
  provenance: {
    goal: string;
    run: string;
    producer: string;
    kind: string;
    real: boolean;
    createdAt: string;
    parent?: { id: string; version: number };
    objective?: string;
    importedFrom?: string;
  };
  revalidation: { suite: string; witnesses: ConsumerWitness[]; instructions: string };
  receipts: string[];
}

export interface VersionState {
  version: number;
  status: CapabilityStatus;
  reason?: string;
  at: string;
}

export interface CapabilityState {
  id: string;
  current: number;
  /** A version pin. Set by the operator; agents only read it. */
  pinned?: number;
  versions: VersionState[];
  history: Array<{ at: string; event: string; detail: string; version?: number }>;
}

export interface Suite {
  cases: TestCase[];
}

export interface RejectedRecord {
  id: string;
  run: string;
  gap: string;
  producer: string;
  kind: string;
  level: EvidenceLevel;
  rejectedAt: string;
  reason: string;
  sha256: string;
  at: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/;
const slugOf = (id: string): string => {
  const s = id.replace(/^exapt:/, "").replace(/@\d+$/, "");
  if (!SLUG.test(s)) throw new Error(`invalid capability id: ${id}`);
  return s;
};

export class Vault {
  readonly root: string;
  constructor(home: string) {
    this.root = home;
    for (const d of ["objects", "capabilities", "rejected"]) fs.mkdirSync(path.join(home, d), { recursive: true });
  }

  // ---------------------------------------------------------- objects

  put(data: string | Uint8Array): string {
    const hash = sha256(data);
    const file = path.join(this.root, "objects", hash);
    if (!fs.existsSync(file)) writeAtomic(file, data);
    return hash;
  }

  /** Reads verify content against the address. A tampered object is an error, not data. */
  get(hash: string): Buffer {
    const data = fs.readFileSync(path.join(this.root, "objects", hash));
    if (sha256(data) !== hash) throw new Error(`object ${hash} does not match its address: refusing to use it`);
    return data;
  }

  // ---------------------------------------------------------- capabilities

  private dir(id: string): string {
    return path.join(this.root, "capabilities", slugOf(id));
  }

  list(): CapabilityState[] {
    const base = path.join(this.root, "capabilities");
    return fs.readdirSync(base).flatMap((slug) => {
      const s = readJson<CapabilityState>(path.join(base, slug, "state.json"));
      return s ? [s] : [];
    });
  }

  state(id: string): CapabilityState | undefined {
    return readJson<CapabilityState>(path.join(this.dir(id), "state.json"));
  }

  manifest(id: string, version?: number): CapabilityManifest | undefined {
    const state = this.state(id);
    if (!state) return undefined;
    const v = version ?? state.pinned ?? state.current;
    return readJson<CapabilityManifest>(path.join(this.dir(id), `v${v}.json`));
  }

  source(m: CapabilityManifest): string {
    return this.get(m.artefact.sha256).toString("utf8");
  }

  suite(m: CapabilityManifest): Suite {
    return JSON.parse(this.get(m.revalidation.suite).toString("utf8")) as Suite;
  }

  private note(state: CapabilityState, event: string, detail: string, version?: number): void {
    state.history.push({ at: new Date().toISOString(), event, detail, ...(version !== undefined ? { version } : {}) });
  }

  private save(state: CapabilityState): void {
    writeJson(path.join(this.dir(state.id), "state.json"), state);
  }

  /** Retain a version. The caller has already established evidence; replacement is explicit, and a
   *  previous version stays on disk so promotion can be audited and rolled back. */
  retain(m: CapabilityManifest): CapabilityState {
    writeJson(path.join(this.dir(m.id), `v${m.version}.json`), m);
    const state = this.state(m.id) ?? { id: m.id, current: m.version, versions: [], history: [] };
    state.versions = state.versions.filter((v) => v.version !== m.version);
    state.versions.push({ version: m.version, status: m.status, at: new Date().toISOString() });
    if (m.status === "verified-within-scope") {
      for (const v of state.versions) if (v.version !== m.version && v.status === "verified-within-scope" && state.pinned === undefined) v.status = "refused", v.reason = `superseded by version ${m.version}`;
      if (state.pinned === undefined) state.current = m.version;
    }
    this.note(state, "retained", `version ${m.version} (${m.status}, ${m.evidence.level})`, m.version);
    this.save(state);
    return state;
  }

  setStatus(id: string, version: number, status: CapabilityStatus, reason: string): void {
    const state = this.state(id);
    if (!state) throw new Error(`unknown capability ${id}`);
    const v = state.versions.find((x) => x.version === version);
    if (!v) throw new Error(`unknown version ${version} of ${id}`);
    v.status = status;
    v.reason = reason;
    v.at = new Date().toISOString();
    this.note(state, `status:${status}`, reason, version);
    this.save(state);
    const m = this.manifest(id, version)!;
    writeJson(path.join(this.dir(id), `v${version}.json`), { ...m, status });
  }

  /** Update a manifest's dependency pins after a successful revalidation. */
  repin(m: CapabilityManifest, dependencies: Dependency[], detail: string): void {
    writeJson(path.join(this.dir(m.id), `v${m.version}.json`), { ...m, dependencies });
    const state = this.state(m.id)!;
    this.note(state, "revalidated", detail, m.version);
    this.save(state);
  }

  addReceipt(m: CapabilityManifest, receipt: string): void {
    const current = readJson<CapabilityManifest>(path.join(this.dir(m.id), `v${m.version}.json`));
    if (!current) return;
    current.receipts = [...current.receipts, receipt].slice(-200);
    writeJson(path.join(this.dir(m.id), `v${m.version}.json`), current);
  }

  /** Operator-only controls. Nothing on the agent-facing surface reaches these. */
  pin(id: string, version: number | null): void {
    const state = this.state(id);
    if (!state) throw new Error(`unknown capability ${id}`);
    if (version === null) delete state.pinned;
    else {
      if (!state.versions.some((v) => v.version === version)) throw new Error(`unknown version ${version} of ${id}`);
      state.pinned = version;
    }
    this.note(state, "pin", version === null ? "version pin removed" : `pinned to version ${version}`);
    this.save(state);
  }

  revoke(id: string, reason: string): void {
    const state = this.state(id);
    if (!state) throw new Error(`unknown capability ${id}`);
    for (const v of state.versions) {
      v.status = "refused";
      v.reason = reason;
      const m = this.manifest(id, v.version);
      if (m) writeJson(path.join(this.dir(id), `v${v.version}.json`), { ...m, status: "refused" });
    }
    this.note(state, "revoked", reason);
    this.save(state);
  }

  record(event: Omit<RejectedRecord, "id" | "at">): void {
    const id = newId("rej");
    writeJson(path.join(this.root, "rejected", `${id}.json`), { ...event, id, at: new Date().toISOString() });
  }

  rejected(limit = 50): RejectedRecord[] {
    const dir = path.join(this.root, "rejected");
    return fs.readdirSync(dir).sort().slice(-limit).reverse().map((f) => readJson<RejectedRecord>(path.join(dir, f))!);
  }

  nextVersion(id: string): number {
    return Math.max(0, ...(this.state(id)?.versions.map((v) => v.version) ?? [])) + 1;
  }

  /** Capabilities that were built on this one. */
  dependents(id: string): CapabilityManifest[] {
    return this.list().flatMap((s) => {
      const m = this.manifest(s.id);
      return m?.dependencies.some((d) => d.kind === "capability" && d.id === id) ? [m] : [];
    });
  }

  // ---------------------------------------------------------- portability

  /** A definition another host can check for itself. Credentials and authority do not exist in it. */
  exportBundle(id: string): CapabilityBundle {
    const m = this.manifest(id);
    if (!m) throw new Error(`unknown capability ${id}`);
    return { format: "exapt/bundle@1", exportedAt: new Date().toISOString(), manifest: { ...m, receipts: [] }, source: this.source(m), suite: this.suite(m), digest: digest({ manifest: stable({ ...m, receipts: [] }), source: this.source(m) }) };
  }

  /** Accept a definition as unverified. It gains no status here until revalidation succeeds. */
  importBundle(bundle: CapabilityBundle): CapabilityManifest {
    if (bundle.format !== "exapt/bundle@1") throw new Error(`unsupported bundle format: ${bundle.format}`);
    if (sha256(bundle.source) !== bundle.manifest.artefact.sha256) throw new Error("bundle source does not match its declared artefact digest");
    const artefact = this.put(bundle.source);
    const suite = this.put(JSON.stringify(bundle.suite));
    const m: CapabilityManifest = {
      ...bundle.manifest,
      status: "synthesised-unverified",
      version: this.nextVersion(bundle.manifest.id),
      artefact: { ...bundle.manifest.artefact, sha256: artefact },
      revalidation: { ...bundle.manifest.revalidation, suite },
      receipts: [],
      provenance: { ...bundle.manifest.provenance, importedFrom: bundle.digest },
    };
    this.retain(m);
    return m;
  }
}

export interface CapabilityBundle {
  format: "exapt/bundle@1";
  exportedAt: string;
  manifest: CapabilityManifest;
  source: string;
  suite: Suite;
  digest: string;
}

export const RUNTIME_IMAGE = IMAGE;
