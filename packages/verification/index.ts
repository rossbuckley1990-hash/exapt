// Independent assessment of a candidate. This runs after the synthesis loop, from a fresh seed and a
// fresh draw of every tier, so the loop's own bookkeeping cannot be what a capability's standing
// rests on. Levels are computed here and nowhere else. No finite test run makes a program universally
// correct, and no report here says otherwise.
import type { EvidenceLevel, Universe } from "../capability-universe/index.ts";
import { compareRecords, isRecordRepr, parseRecords, sniff } from "../capability-universe/index.ts";
import type { ExecutionBackend } from "../execution/index.ts";
import { hasValueOracle, Judge, metamorphicChecks, mutationScore, runCases, syntaxValid, type BehaviouralContract, type MutationScore, type TestBench, type TestCase, type Tier } from "../experiment-engine/index.ts";
import { sha256 } from "../shared/index.ts";

export interface OracleTally {
  name: string;
  independent: boolean;
  valueLevel: boolean;
  runs: number;
  failures: number;
}

export interface EvidenceReport {
  format: "exapt/evidence@1";
  candidate: { sha256: string; producer: string; kind: string };
  level: EvidenceLevel;
  checkedAt: string;
  seed: number;
  tiers: Partial<Record<Tier, { passed: number; total: number }>>;
  oracles: OracleTally[];
  metamorphic: { passed: number; total: number; failures: string[] };
  mutation: MutationScore;
  fieldRecovery?: Record<string, { matched: number; total: number }>;
  domain: string[];
  limitations: string[];
  assessment: string;
  execution: { backend: string; enforces: string[]; notEstablished: string[] };
  failures: Array<{ tier: string; oracle: string; detail: string }>;
}

const VALUE = new Set(["ground-truth", "stated-examples", "inverse-pair", "inverse-route", "operator-checker", "terminal-differential"]);
const INDEPENDENT = new Set([...VALUE, "consumer-acceptance"]);

/** Below this share of value faults caught, the suite is too weak to support the strongest label.
 *  Some faults are equivalent to the original and cannot be caught by any test, so this is not
 *  near 1. A suite without a value-level oracle catches almost none, which is what this separates. */
export const MIN_MUTATION_SCORE = 0.6;
const MIN_VALUE_CASES = 3;

function fieldRecovery(cases: TestCase[], outputs: Array<string | undefined>): Record<string, { matched: number; total: number }> | undefined {
  const out: Record<string, { matched: number; total: number }> = {};
  let any = false;
  cases.forEach((c, i) => {
    const output = outputs[i];
    if (c.origin !== "corpus" || c.expected === undefined || output === undefined) return;
    const syntax = sniff(c.expected).syntax;
    if (!isRecordRepr({ syntax, fields: [], records: 0 })) return;
    let truth;
    let actual;
    try {
      truth = parseRecords(c.expected, syntax);
      actual = parseRecords(output, syntax);
    } catch {
      return;
    }
    any = true;
    for (const name of Object.keys(truth[0] ?? {})) {
      const slot = (out[name] ??= { matched: 0, total: 0 });
      truth.forEach((row, r) => {
        slot.total++;
        if (actual[r] && compareRecords([row], [actual[r]], { fields: [name] }).equal) slot.matched++;
      });
    }
  });
  return any ? out : undefined;
}

export async function verify(o: { universe: Universe; contract: BehaviouralContract; bench: TestBench; backend: ExecutionBackend; source: string; producer: string; kind: string; seed: number; libs?: Record<string, string> }): Promise<EvidenceReport> {
  const { contract, bench, backend, source } = o;
  const judge = new Judge(o.universe, contract);
  const tiers: EvidenceReport["tiers"] = {};
  const oracleRuns = new Map<string, { runs: number; failures: number }>();
  const failures: EvidenceReport["failures"] = [];
  const allCases: TestCase[] = [];
  const allOutputs: Array<string | undefined> = [];
  const valueHoldoutInputs = new Set<string>();
  const run = async (tier: Tier, cases: TestCase[]) => {
    const rs = await runCases(backend, judge, source, cases, o.libs);
    tiers[tier] = { passed: rs.filter((r) => r.passed).length, total: rs.length };
    for (const r of rs) {
      for (const name of r.exercised) {
        const e = oracleRuns.get(name) ?? { runs: 0, failures: 0 };
        e.runs++;
        if (r.failures.some((f) => f.oracle === name)) e.failures++;
        oracleRuns.set(name, e);
      }
      for (const f of r.failures.slice(0, 2)) if (failures.length < 12) failures.push({ tier, oracle: f.oracle, detail: f.detail });
      if (tier === "holdout" && r.passed && hasValueOracle(r)) {
        const c = cases.find(c => c.id === r.id)!;
        valueHoldoutInputs.add(sha256(`${c.binary ? "binary" : "text"}:${c.input}`));
      }
    }
    return rs;
  };
  const syntax = syntaxValid(source);
  let level: EvidenceLevel = syntax.ok ? "syntax-valid" : "not-established";
  const visible = await bench.visible();
  const seen = await run("visible", visible);
  const independentCases = await bench.independent(1000 + o.seed);
  const independent = await run("independent", independentCases);
  const boundaryCases = await bench.boundary();
  const edge = await run("boundary", boundaryCases);
  const malformedCases = bench.malformed();
  const refused = await run("malformed", malformedCases);
  const heldCases = await bench.holdout(1000 + o.seed);
  const held = await run("holdout", heldCases);
  const gather = (cases: TestCase[]) => cases.forEach((c) => allCases.push(c));
  gather(independentCases);
  gather(heldCases);
  const recoveryCases = [...visible, ...independentCases, ...heldCases].filter((c) => c.origin === "corpus");
  for (const c of recoveryCases) {
    const r = await backend.run({ source, input: c.binary ? Buffer.from(c.input, "base64") : c.input, libs: o.libs });
    allOutputs.push(r.output ?? (r.outputBase64 ? Buffer.from(r.outputBase64, "base64").toString("utf8") : undefined));
  }
  const meta = await metamorphicChecks(backend, source, contract, independentCases.length ? independentCases : visible, o.seed, o.libs);
  const mutation = await mutationScore(backend, judge, source, [...visible, ...independentCases, ...boundaryCases, ...malformedCases, ...heldCases], o.libs);

  const passed = (rs: Array<{ passed: boolean }>) => rs.length > 0 && rs.every((r) => r.passed);
  if (seen.some((r) => r.failures.every((f) => f.oracle !== "execution")) || seen.length === 0) level = syntax.ok ? "executed" : level;
  if (passed(seen) && level === "executed") level = "passed-visible";
  const metaOk = meta.results.every((m) => m.passed);
  const mid = (independent.length === 0 || passed(independent)) && edge.every((r) => r.passed) && refused.every((r) => r.passed) && metaOk;
  if (level === "passed-visible" && independent.length > 0 && mid) level = "passed-independent";
  if (level === "passed-independent" && passed(held)) level = "passed-holdout";
  const mutationStrength = mutation.value.total ? mutation.value.killed / mutation.value.total : 0;
  const consumerHeld = !contract.consumer || !oracleRuns.get("consumer-acceptance")?.failures;
  const valueCasesInHoldout = valueHoldoutInputs.size;
  const hasValue = valueCasesInHoldout >= MIN_VALUE_CASES;
  const strongEnough = mutation.value.total === 0 || mutationStrength >= MIN_MUTATION_SCORE;
  if (level === "passed-holdout" && hasValue && consumerHeld && strongEnough) level = "verified-in-domain";

  const oracles: OracleTally[] = [...oracleRuns].map(([name, v]) => ({ name, independent: INDEPENDENT.has(name), valueLevel: VALUE.has(name), ...v }));
  const limitations = [
    "Evidence comes from finite testing. This does not establish correctness outside the stated domain, or universally.",
    ...(hasValue ? [] : [`Only ${valueCasesInHoldout} held-out cases exercised a value-level independent oracle; at least ${MIN_VALUE_CASES} are required for the strongest evidence label.`]),
    ...(strongEnough ? [] : [`The test suite caught only ${mutation.value.killed} of ${mutation.value.total} injected value faults, so it may not be testing what it appears to test.`]),
    ...(contract.consumer ? [`Correct relative to ${o.universe.tool(contract.consumer)?.name} as it behaved when pinned.`] : []),
    ...bench.limitations,
    ...(contract.notCarried?.length ? [`The inverse route does not carry ${contract.notCarried.join(", ")}, so it confirms nothing about these fields.`] : []),
  ];
  const fields = fieldRecovery(recoveryCases, allOutputs);
  if (fields) {
    const lost = Object.entries(fields).filter(([, v]) => v.matched < v.total);
    if (lost.length) limitations.push(`Not fully recovered: ${lost.map(([k, v]) => `${k} (${v.matched}/${v.total})`).join(", ")}.`);
  }
  const worded: Record<EvidenceLevel, string> = {
    "verified-in-domain": `Independently verified within the stated domain: ${tiers.holdout?.total} held-out cases passed with value-level oracles, and ${mutation.value.killed}/${mutation.value.total} injected value faults were caught.`,
    "passed-holdout": "Passed held-out tests, but the evidence does not reach the bar for independent verification.",
    "passed-independent": "Passed independently generated tests. It did not pass held-out tests in this assessment.",
    "passed-visible": "Passed visible examples only. Independent tests refuted or could not assess it.",
    executed: "It ran, but did not pass its visible examples.",
    "syntax-valid": "It parses, but did not run successfully.",
    "not-established": "Nothing about this candidate is established.",
  };
  return {
    format: "exapt/evidence@1",
    candidate: { sha256: sha256(source), producer: o.producer, kind: o.kind },
    level, checkedAt: new Date().toISOString(), seed: o.seed, tiers, oracles,
    metamorphic: { passed: meta.results.filter((m) => m.passed).length, total: meta.results.length, failures: meta.results.filter((m) => !m.passed).map((m) => `${m.relation}: ${m.detail}`) },
    mutation, ...(fields ? { fieldRecovery: fields } : {}),
    domain: bench.describeDomain([...independentCases, ...heldCases]),
    limitations, assessment: worded[level],
    execution: { backend: backend.name, enforces: backend.enforces, notEstablished: backend.notEstablished },
    failures,
  };
}
