// Judging a program's output. Every check here is computed by EXAPT or by a program that existed
// before the candidate did. The model is never asked whether its own answer is right.
import { accepted, compareRecords, isRecordRepr, parseRecords, sameSyntax, sniff, type RecordDiff, type Universe } from "../capability-universe/index.ts";
import type { RunResult } from "../execution/index.ts";
import type { BehaviouralContract, TestCase } from "./bench.ts";

export interface Failure {
  oracle: string;
  detail: string;
  diffs?: RecordDiff[];
}

export interface CaseResult {
  id: string;
  tier: TestCase["tier"];
  passed: boolean;
  failures: Failure[];
  /** Oracles that actually ran on this case. */
  exercised: string[];
  ms: number;
  rssKb?: number;
  output?: string;
}

const textOf = (r: RunResult): string | undefined => r.output ?? (r.outputBase64 !== undefined ? Buffer.from(r.outputBase64, "base64").toString("utf8") : undefined);

export class Judge {
  private readonly universe: Universe;
  private readonly contract: BehaviouralContract;
  constructor(universe: Universe, contract: BehaviouralContract) {
    this.universe = universe;
    this.contract = contract;
  }

  async judge(test: TestCase, run: RunResult): Promise<CaseResult> {
    const base = { id: test.id, tier: test.tier, ms: run.ms, ...(run.rssKb ? { rssKb: run.rssKb } : {}) };
    const fail = (oracle: string, detail: string): CaseResult => ({ ...base, passed: false, failures: [{ oracle, detail }], exercised: [oracle] });
    if (test.tier === "malformed") return this.judgeMalformed(test, run, base);
    if (run.status !== "ok") return fail("execution", `${run.status}: ${run.error ?? ""}`);
    const output = textOf(run);
    if (output === undefined) return fail("execution", "no output");
    const failures: Failure[] = [];
    const exercised: string[] = [];
    const target = this.contract.target;
    if (isRecordRepr(target.repr)) {
      exercised.push("target-representation");
      const repr = sniff(output);
      if (!sameSyntax(repr.syntax, target.repr.syntax)) {
        // A single record can read as another syntax; parse strictly before refusing it.
        let parsed = false;
        try {
          parsed = parseRecords(output, target.repr.syntax).length > 0;
        } catch {
          parsed = false;
        }
        if (!parsed) failures.push({ oracle: "target-representation", detail: `output is ${repr.syntax.format}, expected ${target.repr.syntax.format}` });
      }
      if (/\b(NaN|undefined)\b/.test(output)) failures.push({ oracle: "target-representation", detail: "output contains NaN or undefined" });
    }
    if (test.expected !== undefined) {
      const oracle = test.origin === "corpus" ? "ground-truth" : test.origin === "stated-example" ? "stated-examples" : "inverse-pair";
      exercised.push(oracle);
      const verdict = this.compareExpected(test.expected, output);
      if (verdict) failures.push({ oracle, ...verdict });
    }
    if (this.contract.consumer && !(test.origin === "boundary" && /empty/.test(test.note ?? ""))) {
      const consumer = this.universe.tool(this.contract.consumer)!;
      exercised.push("consumer-acceptance");
      const r = await consumer.run(output).catch((e) => ({ ok: false, stdout: "", stderr: String(e) }));
      if (!accepted(r)) failures.push({ oracle: "consumer-acceptance", detail: `${consumer.name} refused the output: ${(r.stderr || r.stdout).trim().slice(0, 200)}` });
    }
    if (!test.binary && isRecordRepr(this.contract.source.repr)) {
      for (const o of this.contract.oracles) {
        if (o.kind === "inverse-route" && !failures.length) {
          exercised.push("inverse-route");
          const verdict = await this.throughInverse(o.route, test.input, output);
          if (verdict) failures.push({ oracle: "inverse-route", ...verdict });
        }
        if (o.kind === "operator-checker") {
          exercised.push("operator-checker");
          const checker = this.universe.tool(o.program);
          const r = checker ? await checker.run(JSON.stringify({ input: test.input, output })).catch(() => null) : null;
          if (!r || !accepted(r)) failures.push({ oracle: "operator-checker", detail: r ? (r.stderr || r.stdout).trim().slice(0, 200) : "checker unavailable" });
        }
      }
    }
    return { ...base, passed: failures.length === 0, failures, exercised, output: test.tier === "visible" ? output.slice(0, 4000) : undefined };
  }

  private compareExpected(expected: string, output: string): { detail: string; diffs?: RecordDiff[] } | null {
    const syntax = sniff(expected).syntax;
    if (!isRecordRepr({ syntax, fields: [], records: 0 })) return expected.trim() === output.trim() ? null : { detail: "output differs from the expected text" };
    let actual;
    try {
      actual = parseRecords(output, syntax);
    } catch (e) {
      return { detail: `output cannot be read as ${syntax.format}: ${(e as Error).message}` };
    }
    const c = compareRecords(parseRecords(expected, syntax), actual);
    return c.equal ? null : { detail: `${c.diffs.length} difference(s), first: ${describeDiff(c.diffs[0])}`, diffs: c.diffs };
  }

  private async throughInverse(route: string[], input: string, output: string): Promise<{ detail: string; diffs?: RecordDiff[] } | null> {
    let cur = output;
    for (const id of route) {
      const t = this.universe.tool(id)!;
      const r = await t.run(cur).catch(() => null);
      if (!r || !accepted(r)) return { detail: `${t.name} could not read the output back` };
      cur = r.stdout;
    }
    const syntax = this.contract.source.repr.syntax;
    const c = compareRecords(parseRecords(input, syntax), parseRecords(cur, syntax), { tolerance: this.contract.tolerance });
    return c.equal ? null : { detail: `reading the output back does not reproduce the input: ${describeDiff(c.diffs[0])}`, diffs: c.diffs };
  }

  private async judgeMalformed(test: TestCase, run: RunResult, base: Pick<CaseResult, "id" | "tier" | "ms">): Promise<CaseResult> {
    const exercised = ["malformed-refusal"];
    if (run.status === "threw") return { ...base, passed: true, failures: [], exercised };
    if (run.status !== "ok") return { ...base, passed: false, failures: [{ oracle: "malformed-refusal", detail: `did not refuse cleanly: ${run.status}` }], exercised };
    const output = textOf(run) ?? "";
    // Returning normally is acceptable only if nothing was invented or lost.
    if (/\b(NaN|undefined)\b/.test(output)) return { ...base, passed: false, failures: [{ oracle: "malformed-refusal", detail: `"${test.note}": returned NaN or undefined instead of refusing` }], exercised };
    if (output.trim() === "") return { ...base, passed: true, failures: [], exercised };
    return { ...base, passed: false, failures: [{ oracle: "malformed-refusal", detail: `"${test.note}": returned data instead of refusing` }], exercised };
  }
}

export function describeDiff(d: RecordDiff | undefined): string {
  if (!d) return "(none)";
  return d.row < 0 ? `${d.field}: expected ${d.expected}, got ${d.actual}` : `row ${d.row + 1}, ${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`;
}
