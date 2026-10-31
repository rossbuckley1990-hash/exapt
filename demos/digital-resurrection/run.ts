// Demonstration 2. Bytes in a format nothing here can read, an independent record of what they hold,
// and a reusable converter that must prove itself on files, and schemas, it never saw. EXAPT is told
// neither the name of the format nor anything about it.
import fs from "node:fs";
import path from "node:path";
import { accepted, compareRecords, parseRecords, sniff, sniffSyntax } from "../../packages/capability-universe/index.ts";
import type { Goal } from "../../packages/capability-universe/index.ts";
import { bad, good, heading, openEngine, printAttempts, printEvidence, saveReport, say, synthesisLine, workspace } from "../support.ts";

const CORPUS = path.join(import.meta.dirname, "corpus");

interface Manifest {
  files: Array<{ name: string }>;
  quality: { rule: string; verdicts: Array<{ name: string; admissible: boolean; dbfRecords: number; truthRecords: number; agreement: number }> };
}

const manifest = (): Manifest => JSON.parse(fs.readFileSync(path.join(CORPUS, "MANIFEST.json"), "utf8")) as Manifest;

/** Pairs an independent reader found inconsistent are out, by a rule fixed before any candidate
 *  existed: no correct program could match them. See check-corpus.py. */
export function corpusGoal(): Goal {
  const m = manifest();
  const admissible = new Set(m.quality.verdicts.filter((v) => v.admissible).map((v) => v.name));
  return {
    id: "resurrect-obsolete-tables",
    intent: "Recover the records held in these old table files as newline-delimited JSON",
    corpus: m.files.filter((f) => admissible.has(f.name)).map((f) => ({ name: f.name, input: { path: `${f.name}.dbf` }, truth: { path: `${f.name}.truth.ndjson` } })),
    want: { description: "One JSON object per record, with the file's own field names" },
  };
}

export async function demo2(opts: { seed?: number; dir?: string } = {}): Promise<{ ok: boolean; capability?: string; dir: string; report: string; level?: string }> {
  const seed = opts.seed ?? 3;
  const dir = opts.dir ?? workspace("demo2");
  const readers = ["/usr/bin/od", "/usr/bin/file"].filter((p) => fs.existsSync(p));
  const exapt = await openEngine(path.join(dir, ".exapt"), readers);
  const goal = corpusGoal();
  heading("Demonstration 2: digital resurrection");
  say(`Corpus: ${goal.corpus!.length} files from Natural Earth (public domain), with truth from its independently produced GeoJSON.`);
  say("EXAPT is not told what format these are.");
  for (const v of manifest().quality.verdicts.filter((x) => !x.admissible)) say(`excluded before any candidate existed: ${v.name} (${v.dbfRecords} records against ${v.truthRecords}, ${(v.agreement * 100).toFixed(1)}% of cells agree: its GeoJSON comes from a different data release)`);

  heading("1. What can the available tools do with these bytes?");
  await exapt.discover();
  const sample = fs.readFileSync(path.join(CORPUS, "ne_110m_lakes.dbf"));
  say(`The bytes sniff as ${sniff(sample).syntax.format}, magic ${sample.subarray(0, 4).toString("hex")}.`);
  for (const t of exapt.universe.usable()) {
    const r = await t.run(sample).catch(() => null);
    say(`pre-existing  ${t.name}: ${r && accepted(r) ? `produces ${sniff(r.stdout).syntax.format}, not records: ${r.stdout.split("\n")[0].slice(0, 70)}` : "cannot read it"}`);
  }

  heading("2. Determine what is missing");
  const a = await exapt.analyseCompact(goal, CORPUS);
  say(`${a.status}. ${a.summary}`);

  heading("3. Construct and test the converter");
  const run = await exapt.startInvention(goal, CORPUS, { seed });
  printAttempts(run);
  for (const n of run.notes.slice(0, 4)) say(`note: ${n}`);
  say(synthesisLine(run));

  heading("4. Independent assessment");
  printEvidence(run);
  const recovery = run.evidence?.fieldRecovery;
  if (recovery) {
    const entries = Object.entries(recovery);
    const whole = entries.filter(([, v]) => v.matched === v.total);
    const total = entries.reduce((n, [, v]) => n + v.total, 0);
    const matched = entries.reduce((n, [, v]) => n + v.matched, 0);
    say(`field values recovered: ${matched}/${total} across ${entries.length} distinct fields; ${whole.length} fields fully recovered`);
    for (const [k, v] of entries.filter(([, x]) => x.matched < x.total).slice(0, 12)) bad(`unrecovered: ${k} ${v.matched}/${v.total}`);
  }

  heading("5. A file becomes usable through the retained capability");
  let unseen = { files: 0, records: 0, ok: 0 };
  if (run.capability?.status === "verified-within-scope") {
    const m = exapt.vault.manifest(run.capability.id)!;
    for (const f of goal.corpus!) {
      const bytes = fs.readFileSync(path.join(CORPUS, f.input.path!));
      const truth = fs.readFileSync(path.join(CORPUS, f.truth.path!), "utf8");
      const r = await exapt.use(run.capability.id, bytes.toString("base64"), { encoding: "base64" });
      const syntax = sniffSyntax(truth);
      const c = compareRecords(parseRecords(truth, syntax), parseRecords(r.output, syntax));
      unseen.files++;
      unseen.records += parseRecords(truth, syntax).length;
      if (c.equal) unseen.ok++;
      else say(`${f.name}: ${JSON.stringify(c.diffs[0]).slice(0, 120)}`);
    }
    say(`${unseen.ok}/${unseen.files} files recovered exactly (${unseen.records} records) by ${m.id}@${m.version}`);
  } else say("No capability was retained: nothing here can read these files.");
  const ok = run.capability?.status === "verified-within-scope";
  const report = saveReport(dir, "demo2-report", { seed, analysis: { status: a.status, gap: a.gaps[0]?.title }, attempts: run.attempts.map((x) => ({ producer: x.candidate.producer, level: x.level, rejectedAt: x.rejectedAt, reason: x.reason })), evidence: run.evidence, synthesis: run.synthesis, capability: run.capability, recovered: unseen, notes: run.notes });
  console.log(`\n${ok ? "\x1b[32mDemonstration 2 passed.\x1b[0m" : "\x1b[33mDemonstration 2: no verified converter was established.\x1b[0m"} Report: ${report}`);
  await exapt.host.rc.flush();
  return { ok, capability: run.capability?.id, dir, report, level: run.evidence?.level };
}
