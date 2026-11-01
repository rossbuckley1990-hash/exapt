// What the demonstrations share: printing that keeps generated, pre-existing, verified and
// unverified visibly apart, and a report written next to the run.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFromEnv, Exapt, type ExaptConfig, type RunRecord } from "../packages/protocol/engine.ts";

export const heading = (s: string) => console.log(`\n\x1b[1m${s}\x1b[0m`);
export const say = (s: string) => console.log(`  ${s}`);
export const good = (s: string) => console.log(`  \x1b[32m✓\x1b[0m ${s}`);
export const bad = (s: string) => console.log(`  \x1b[31m✗\x1b[0m ${s}`);

export function workspace(name: string): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `exapt-${name}-`)));
}

export function openEngine(home: string, programs: string[], extra: Partial<ExaptConfig> = {}): Promise<Exapt> {
  return Exapt.open(configFromEnv(process.env, { home, programs, ...extra }));
}

export function synthesisLine(r: RunRecord): string {
  if (!r.synthesis || r.synthesis.mode === "none") return "no accepted candidate";
  if (r.synthesis.mode === "model") return `REAL MODEL synthesis by ${r.synthesis.producer}`;
  if (r.synthesis.mode === "deterministic") return `DETERMINISTIC synthesis by ${r.synthesis.producer}, no model involved`;
  return `TEST DOUBLE ${r.synthesis.producer}: not a model`;
}

export function printAttempts(r: RunRecord): void {
  for (const a of r.attempts) {
    const line = `${a.candidate.producer}: reached ${a.level}`;
    if (a.survived) good(line);
    else bad(`${line}, rejected at ${a.rejectedAt}: ${(a.reason ?? "").slice(0, 130)}`);
  }
}

export function printEvidence(r: RunRecord): void {
  const e = r.evidence;
  if (!e) return say("no independent assessment was made");
  say(`evidence level: \x1b[1m${e.level}\x1b[0m`);
  for (const [tier, t] of Object.entries(e.tiers)) say(`  ${tier.padEnd(12)} ${t.passed}/${t.total}`);
  say(`  metamorphic  ${e.metamorphic.passed}/${e.metamorphic.total}`);
  for (const o of e.oracles) say(`  oracle ${o.name}: ${o.runs - o.failures}/${o.runs}${o.valueLevel ? " (value-level)" : ""}${o.independent ? " (independent)" : ""}`);
  say(`  injected value faults caught: ${e.mutation.value.killed}/${e.mutation.value.total}; all faults: ${e.mutation.killed}/${e.mutation.total}`);
  for (const l of e.limitations) say(`  limit: ${l}`);
}

export function saveReport(dir: string, name: string, report: unknown): string {
  const file = path.join(dir, `${name}.json`);
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  return file;
}
