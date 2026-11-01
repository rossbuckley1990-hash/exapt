// Turns trial files into the results tables, by the frozen scoring. Nothing here chooses what to show:
// every trial on disk appears.
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, type TaskSpec } from "./families.ts";
import { judge, type Trial } from "./scoring.ts";

const label = process.argv[2] ?? "primary-sonnet";
const dir = path.join(import.meta.dirname, "results", label);
const trials = fs.readdirSync(dir).filter((f) => f.endsWith(".json") && f !== "summary.json").map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Trial);
const specs = new Map(fs.readdirSync(FIXTURES).filter((d) => fs.existsSync(path.join(FIXTURES, d, "task.json"))).map((d) => [d, JSON.parse(fs.readFileSync(path.join(FIXTURES, d, "task.json"), "utf8")) as TaskSpec]));
const tasks = [...specs.keys()].sort();
const ARMS = ["A", "B", "C", "D"] as const;
const find = (t: string, a: string, s: string) => trials.find((x) => x.task === t && x.arm === a && x.stage === s);
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};

function cell(t: Trial | undefined, answer: "done" | "not-possible"): string {
  if (!t) return "not run";
  if (t.incomplete) return "incomplete";
  const v = judge(t, answer);
  if (v.correct) return t.claimed === "not-possible" ? "correct refusal" : `correct ${t.hidden.passed}/${t.hidden.total}`;
  if (v.falseSuccess) return `FALSE SUCCESS ${t.hidden.passed}/${t.hidden.total}`;
  return "refused";
}

const lines: string[] = [];
const out = (s = "") => lines.push(s);
out(`# Results: ${label}`);
out();
out(`${trials.length} trials. Total reported cost $${trials.filter((t) => !(t.arm === "B" && t.stage === "cold")).reduce((n, t) => n + t.costUsd, 0).toFixed(2)}.`);
out();
out("## Cold");
out();
out("| Task | A/B agent | C RightClick X | D EXAPT | D level | Unverified D candidate |");
out("|---|---|---|---|---|---|");
for (const id of tasks) {
  const s = specs.get(id)!;
  const d = find(id, "D", "cold");
  const detail = d?.detail as { unverified?: { passed: number; total: number } } | undefined;
  const level = d?.notes.find((n) => n.startsWith("level "))?.slice(6) ?? "";
  out(`| ${id} | ${cell(find(id, "A", "cold"), s.answer)} | ${cell(find(id, "C", "cold"), s.answer)} | ${cell(d, s.answer)} | ${level} | ${detail?.unverified ? `${detail.unverified.passed}/${detail.unverified.total}` : ""} |`);
}
out();
const score = (arm: string, stage: string) => {
  const ts = tasks.flatMap((id) => {
    const t = find(id, arm, stage);
    return t ? [{ t, v: judge(t, specs.get(id)!.answer) }] : [];
  });
  return { n: ts.length, correct: ts.filter((x) => x.v.correct).length, falseSuccess: ts.filter((x) => x.v.falseSuccess && !x.t.incomplete).length, refused: ts.filter((x) => x.v.falseRefusal && !x.t.incomplete).length, incomplete: ts.filter((x) => x.t.incomplete).length, cost: ts.reduce((n, x) => n + x.t.costUsd, 0), medianCost: median(ts.map((x) => x.t.costUsd)), tokens: ts.reduce((n, x) => n + x.t.inputTokens + x.t.outputTokens, 0), medianSeconds: median(ts.map((x) => x.t.ms / 1000)), code: ts.reduce((n, x) => n + x.t.codeBytes, 0) };
};
out("## Totals");
out();
out("| Stage | Arm | Trials | Correct | False success | Refused or no claim | Incomplete | Total cost | Median cost | Median seconds | Tokens | Code bytes |");
out("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const stage of ["cold", "drift", "warm"]) for (const arm of ARMS) {
  const s = score(arm, stage);
  if (s.n) out(`| ${stage} | ${arm} | ${s.n} | ${s.correct} | ${s.falseSuccess} | ${s.refused} | ${s.incomplete} | $${s.cost.toFixed(3)} | $${s.medianCost.toFixed(3)} | ${s.medianSeconds.toFixed(0)} | ${s.tokens} | ${s.code} |`);
}
for (const stage of ["drift", "warm"]) {
  out();
  out(`## ${stage === "drift" ? "Drift" : "Warm"}`);
  out();
  out("| Task | A | B | D | D tool calls |");
  out("|---|---|---|---|---|");
  for (const id of tasks) {
    if (!find(id, "D", stage)) continue;
    const s = specs.get(id)!;
    out(`| ${id} | ${cell(find(id, "A", stage), s.answer)} | ${cell(find(id, "B", stage), s.answer)} | ${cell(find(id, "D", stage), s.answer)} | ${find(id, "D", stage)?.toolCalls?.length ?? 0} |`);
  }
}
const unauthorised = trials.filter((t) => t.unauthorised?.length);
out();
out(`Unauthorised effects: ${unauthorised.length ? unauthorised.map((t) => `${t.task} ${t.arm}/${t.stage}`).join(", ") : "none recorded"}.`);
fs.writeFileSync(path.join(dir, "RESULTS.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
