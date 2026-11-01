// Experience ledger and receipt chain.
//
// The ledger is how the graph learns: every run updates the capability's
// observed success rate and latency, and the planner prices edges with it.
// Receipts are a SHA-256 hash chain, so a run log exported from one region
// can be checked anywhere without trusting the instance that produced it.

import type { HttpContinuationEvidence } from "../reflectors/http-continuation.ts";
import type { CliValidity } from "./cli-outcome.ts";

export interface Experience {
  runs: number;
  ok: number;
  failed: number;
  /** Exponential moving average, milliseconds. */
  latencyMs: number;
  /** Exponential moving average of success (1 = ok), so the ledger notices change. */
  recent?: number;
  lastRunAt?: string;
  lastError?: string;
}

export class Ledger {
  readonly stats = new Map<string, Experience>();

  record(id: string, ok: boolean, latencyMs: number, error?: string): Experience {
    const e = this.stats.get(id) ?? { runs: 0, ok: 0, failed: 0, latencyMs };
    e.runs++;
    if (ok) e.ok++;
    else e.failed++;
    e.latencyMs = e.runs === 1 ? latencyMs : e.latencyMs * 0.7 + latencyMs * 0.3;
    e.recent = e.runs === 1 || e.recent === undefined ? (ok ? 1 : 0) : e.recent * 0.8 + (ok ? 0.2 : 0);
    e.lastRunAt = new Date().toISOString();
    if (error) e.lastError = error.slice(0, 300);
    this.stats.set(id, e);
    return e;
  }

  /** Clear failure history for matching capabilities (e.g. credentials for their origin changed). */
  forgive(match: (id: string, e: Experience) => boolean): string[] {
    const forgiven: string[] = [];
    for (const [id, e] of this.stats) {
      if (!match(id, e)) continue;
      this.stats.set(id, { runs: e.ok, ok: e.ok, failed: 0, latencyMs: e.latencyMs, recent: e.ok ? 1 : undefined, lastRunAt: e.lastRunAt });
      forgiven.push(id);
    }
    return forgiven;
  }

  get(id: string): Experience | undefined {
    return this.stats.get(id);
  }

  /** Laplace-smoothed success probability: unknown capabilities start at 0.75. */
  reliability(id: string): number {
    const e = this.stats.get(id);
    if (!e) return 0.75;
    const lifetime = (e.ok + 3) / (e.runs + 4);
    if (e.runs < 3 || e.recent === undefined) return lifetime;
    // Recent behaviour dominates: a provider that starts failing loses trust fast.
    return Math.max(0.02, 0.25 * lifetime + 0.75 * e.recent);
  }

  /** Planner edge cost: one step, inflated by unreliability, nudged by latency. */
  cost(id: string): number {
    const e = this.stats.get(id);
    const latency = e ? Math.min(e.latencyMs, 10_000) / 10_000 : 0.05;
    return 1 / this.reliability(id) + latency;
  }

  toJSON(): Record<string, Experience> {
    return Object.fromEntries(this.stats);
  }

  load(data: Record<string, Experience>): void {
    for (const [k, v] of Object.entries(data ?? {})) this.stats.set(k, v);
  }
}

export interface Receipt {
  seq: number;
  runId: string;
  capability: string;
  provider: string;
  startedAt: string;
  durationMs: number;
  status: "completed" | "failed" | "pending";
  verification: "verified" | "checked" | "refuted" | "unverified";
  /** Local continuation observations, hash-bound to this receipt; not independent authority proof. */
  httpContinuation?: HttpContinuationEvidence;
  /** Local observations, not independent verification or authority. */
  cliValidity?: CliValidity;
  /** This receipt continues a retained execution without replaying completed actions. */
  resumes?: string;
  /** Complete selected saved-goal execution; never a leaf-only continuation. */
  workflowRunId?: string;
  inputDigest: string;
  outputDigest: string;
  prev: string;
  hash: string;
}

export async function sha256(data: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function stableStringify(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined)
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

const GENESIS = "0".repeat(64);

export class ReceiptChain {
  readonly receipts: Receipt[] = [];
  private head = GENESIS;

  private tail: Promise<unknown> = Promise.resolve();

  /** Appends are serialized: concurrent runs must never link to the same previous receipt. */
  append(r: Omit<Receipt, "seq" | "prev" | "hash" | "inputDigest" | "outputDigest">, input: unknown, output: unknown): Promise<Receipt> {
    const next = this.tail.then(() => this.appendNow(r, input, output));
    this.tail = next.catch(() => {});
    return next;
  }

  private async appendNow(r: Omit<Receipt, "seq" | "prev" | "hash" | "inputDigest" | "outputDigest">, input: unknown, output: unknown): Promise<Receipt> {
    const body = {
      ...r,
      seq: this.receipts.length + 1,
      inputDigest: await sha256(stableStringify(input)),
      outputDigest: await sha256(stableStringify(output)),
      prev: this.head,
    };
    const hash = await sha256(stableStringify(body));
    const receipt: Receipt = { ...body, hash };
    this.receipts.push(receipt);
    this.head = hash;
    return receipt;
  }

  /** Resume a persisted chain; new receipts link onto its last hash. */
  restore(receipts: Receipt[]): void {
    this.receipts.push(...receipts);
    if (receipts.length) this.head = receipts[receipts.length - 1].hash;
  }

  get headHash(): string {
    return this.head;
  }

  /** Recompute every link. Returns the first broken seq, or null when intact. */
  static async verify(receipts: Receipt[]): Promise<number | null> {
    let prev = receipts[0]?.prev ?? GENESIS;
    for (const r of receipts) {
      const { hash, ...body } = r;
      if (r.prev !== prev || (await sha256(stableStringify(body))) !== hash) return r.seq;
      prev = hash;
    }
    return null;
  }
}
