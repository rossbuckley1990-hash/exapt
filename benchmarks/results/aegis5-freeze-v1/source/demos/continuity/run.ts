import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { compareRecords, parseRecords, sniffSyntax, type Goal } from "../../packages/capability-universe/index.ts";
import type { CapabilityBundle } from "../../packages/capability-memory/index.ts";
import type { Exapt } from "../../packages/protocol/engine.ts";
import { sha256, writeJson } from "../../packages/shared/index.ts";
import { corpusGoal } from "../digital-resurrection/run.ts";
import { bad, good, heading, openEngine, printAttempts, printEvidence, saveReport, say, synthesisLine, workspace } from "../support.ts";

const CORPUS = path.join(import.meta.dirname, "../digital-resurrection/corpus");
const DRILL_NAMES = new Set([
  "ne_110m_admin_0_scale_rank",
  "ne_110m_geography_regions_elevation_points",
  "ne_110m_geographic_lines",
]);

export interface ContinuityCapsule {
  format: "exapt/continuity@1";
  createdAt: string;
  workflow: { id: string; intent: string };
  capability: CapabilityBundle;
}

export function continuityFixture(): { goal: Goal; drills: NonNullable<Goal["corpus"]> } {
  const corpus = corpusGoal().corpus ?? [];
  const drills = corpus.filter((c) => DRILL_NAMES.has(c.name ?? ""));
  const learning = corpus.filter((c) => !DRILL_NAMES.has(c.name ?? ""));
  if (learning.length !== 7 || drills.length !== 3) throw new Error("Continuity fixture must contain seven learning files and three outage drills");
  return {
    goal: {
      id: "continuity-natural-earth",
      intent: "Keep these records readable as newline-delimited JSON after the original reader disappears",
      corpus: learning,
      want: {},
    },
    drills,
  };
}

export function readContinuityCapsule(file: string): ContinuityCapsule {
  const capsule = JSON.parse(fs.readFileSync(file, "utf8")) as ContinuityCapsule;
  if (capsule.format !== "exapt/continuity@1" || !capsule.capability || !capsule.workflow) throw new Error("invalid Continuity capsule");
  return capsule;
}

export async function runContinuity(opts: { seed?: number; dir?: string } = {}): Promise<{ ok: boolean; dir: string; report: string; capsule?: string }> {
  const seed = opts.seed ?? 3;
  const dir = opts.dir ?? workspace("continuity");
  const { goal, drills } = continuityFixture();
  const report: Record<string, unknown> = {
    seed,
    claim: "A workflow retains an exact, independently checked standby after its original host programs disappear.",
    learningFiles: goal.corpus!.map((c) => c.name),
    outageDrillFiles: drills.map((c) => c.name),
    caveat: "A shadow outage with no authorized host programs, not deletion of software from this machine. Finite evidence is not universal correctness or proof of world-first novelty.",
  };
  let source: Exapt | undefined;
  let outage: Exapt | undefined;
  let ok = false;
  let capsulePath: string | undefined;

  try {
    heading("Continuity: rehearse the disappearance of software");
    say("Before the outage, seven real schemas and their independent reference outputs are available.");
    say("Three other schemas are excluded from the invention goal and reserved for the outage drill.");
    const readers = ["/usr/bin/od", "/usr/bin/file"].filter((p) => fs.existsSync(p));
    source = await openEngine(path.join(dir, "before-outage"), readers, { model: null, strategy: "deterministic-only" });

    heading("1. Build a standby without a model or a format specification");
    const run = await source.startInvention(goal, CORPUS, { seed, strategy: "deterministic-only" });
    printAttempts(run);
    say(synthesisLine(run));
    printEvidence(run);
    report.preLoss = {
      outcome: run.outcome,
      capability: run.capability,
      synthesis: run.synthesis,
      modelCalls: run.budget?.calls,
      evidence: run.evidence,
    };

    if (run.capability?.status === "verified-within-scope") {
      heading("2. Freeze the capability, evidence, revalidation suite, and limits");
      const capsule: ContinuityCapsule = {
        format: "exapt/continuity@1",
        createdAt: new Date().toISOString(),
        workflow: { id: goal.id, intent: goal.intent },
        capability: source.exportCapability(run.capability.id),
      };
      capsulePath = path.join(dir, "continuity-capsule.json");
      writeJson(capsulePath, capsule);
      const restoredCapsule = readContinuityCapsule(capsulePath);
      const capsuleHash = sha256(fs.readFileSync(capsulePath));
      report.capsule = {
        path: capsulePath,
        sha256: capsuleHash,
        sourceSha256: capsule.capability.manifest.artefact.sha256,
        limitations: capsule.capability.manifest.limitations,
      };
      good(`capsule ${capsuleHash.slice(0, 16)}`);

      heading("3. Shadow outage: a fresh host with zero authorized programs");
      outage = await openEngine(path.join(dir, "after-outage"), [], { model: null, strategy: "deterministic-only" });
      const discovery = await outage.discover();
      const imported = await outage.importCapability(restoredCapsule.capability);
      const importedManifest = outage.vault.manifest(run.capability.id)!;
      say(`authorized host programs: ${discovery.programs}`);
      say(`import: ${imported.revalidation.outcome}, ${imported.revalidation.checks.passed}/${imported.revalidation.checks.total} stored checks reproduced`);
      if (imported.revalidation.outcome === "accepted-import" && importedManifest.status === "verified-within-scope") good("authority was earned locally; the capsule's original status was not trusted");
      else bad("the capsule did not establish itself in the outage environment");

      heading("4. Use the standby on files excluded from invention");
      const drillResults: Array<Record<string, unknown>> = [];
      for (const drill of drills) {
        const input = fs.readFileSync(path.join(CORPUS, drill.input.path!));
        const expected = fs.readFileSync(path.join(CORPUS, drill.truth.path!), "utf8");
        const syntax = sniffSyntax(expected);
        let result: Record<string, unknown>;
        try {
          const used = await outage.use(run.capability.id, input.toString("base64"), { encoding: "base64" });
          const comparison = compareRecords(parseRecords(expected, syntax), parseRecords(used.output, syntax));
          result = {
            name: drill.name,
            inputSha256: sha256(input),
            records: parseRecords(expected, syntax).length,
            exact: comparison.equal,
            receipt: used.receipt,
            firstDifference: comparison.diffs[0],
          };
        } catch (e) {
          result = { name: drill.name, inputSha256: sha256(input), exact: false, error: String((e as Error).message ?? e) };
        }
        drillResults.push(result);
        if (result.exact) good(`${drill.name}: ${result.records} records recovered exactly`);
        else bad(`${drill.name}: ${JSON.stringify(result.firstDifference ?? result.error).slice(0, 140)}`);
      }

      const tampered = structuredClone(restoredCapsule);
      tampered.capability.source = "export function transform() { return ''; }\n";
      let tamperRefusal = "";
      try {
        await outage.importCapability(tampered.capability);
      } catch (e) {
        tamperRefusal = String((e as Error).message ?? e);
      }
      const tamperRefused = tamperRefusal.includes("does not match");
      if (tamperRefused) good("a modified capsule was refused before it could become an operation");
      else bad("a modified capsule was not refused");

      report.outage = {
        hostPrograms: discovery.programs,
        revalidation: imported.revalidation,
        importedStatus: importedManifest.status,
        drills: drillResults,
        exactFiles: drillResults.filter((r) => r.exact).length,
        exactRecords: drillResults.filter((r) => r.exact).reduce((n, r) => n + Number(r.records ?? 0), 0),
        tamperRefused,
        tamperRefusal,
      };
      ok = run.synthesis?.mode === "deterministic"
        && run.budget?.calls === 0
        && discovery.programs === 0
        && imported.revalidation.outcome === "accepted-import"
        && importedManifest.status === "verified-within-scope"
        && drillResults.length === 3
        && drillResults.every((r) => r.exact)
        && tamperRefused;
    } else {
      bad(`no verified standby was established: ${run.outcome}`);
    }
  } catch (e) {
    report.error = String((e as Error).stack ?? e);
    bad(String((e as Error).message ?? e));
  } finally {
    if (source) await source.host.rc.flush();
    if (outage) await outage.host.rc.flush();
  }

  report.ok = ok;
  const reportPath = saveReport(dir, "continuity-report", report);
  console.log(`\n${ok ? "\x1b[32mContinuity drill passed.\x1b[0m" : "\x1b[31mContinuity drill did not pass.\x1b[0m"} Report: ${reportPath}`);
  return { ok, dir, report: reportPath, ...(capsulePath ? { capsule: capsulePath } : {}) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dirIndex = process.argv.indexOf("--dir");
  const dir = dirIndex >= 0 && process.argv[dirIndex + 1] ? path.resolve(process.argv[dirIndex + 1]) : undefined;
  runContinuity({ dir }).then((r) => {
    process.exitCode = r.ok ? 0 : 1;
  }, (e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
