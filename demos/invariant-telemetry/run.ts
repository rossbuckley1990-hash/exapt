// Demonstration 4: The Invariant-Synthesizing Telemetry Fabric (Project AEGIS).
// Proves autonomous reverse-engineering and synthesis of Darwin kernel Mach VM telemetry
// under physical conservation laws, catching AI hallucinations and sealing verified capabilities.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { accepted, compareRecords, parseRecords, sniffSyntax } from "../../packages/capability-universe/index.ts";
import { bad, good, heading, openEngine, printAttempts, printEvidence, saveReport, say, synthesisLine, workspace } from "../support.ts";
import { negativeControls } from "./controls.ts";
import { referenceAdapter, writeTelemetryEnvironment, type TelemetryEnv } from "./environment.ts";
import type { ExaptConfig } from "../../packages/protocol/engine.ts";

export interface Demo4Result {
  ok: boolean;
  dir: string;
  report: string;
  capability?: string;
  liveMemoryGb?: string;
}

export async function demo4(opts: { seed?: number; dir?: string; engineConfig?: Partial<ExaptConfig> } = {}): Promise<Demo4Result> {
  const seed = opts.seed ?? 2026;
  const dir = opts.dir ?? workspace("demo4-invariant-telemetry");
  const env: TelemetryEnv = writeTelemetryEnvironment(dir);
  const home = path.join(dir, ".exapt");
  const exapt = await openEngine(home, [env.programs], opts.engineConfig);

  heading("Demonstration 4: Invariant-Synthesizing Telemetry Fabric (Project AEGIS)");
  say(`Host Platform: Darwin ${process.arch} with ${env.pageSize}-byte hardware page size`);
  say(`Environment: Consumer '${env.collector}' checks schema; separate expected outputs check values.`);
  say(`Goal: ${env.goal.intent}`);

  heading("1. Discover existing environment and contracts");
  const discovery = await exapt.discover();
  for (const t of exapt.universe.usable()) {
    say(`discovered: ${t.name.padEnd(28)} ${t.contract.docs ? `"${t.contract.docs.split("\n")[0]}"` : ""}`);
  }
  good(`${discovery.learned.length} interfaces established by experiment.`);

  heading("2. Confirm existing tools refuse raw kernel telemetry directly");
  const sample = fs.readFileSync(env.samplePath, "utf8");
  const collectorTool = exapt.universe.tool(env.collector)!;
  const directRun = await collectorTool.run(sample).catch((e) => ({ ok: false, stdout: "", stderr: String(e.message) }));
  if (accepted(directRun)) {
    bad("the collector accepted raw vm_stat output directly without conversion");
  } else {
    good(`kernel-telemetry-collector properly refused raw vm_stat: ${(directRun.stderr || "").trim().slice(0, 80)}`);
  }

  heading("3. Detect the computational gap");
  const analysis = await exapt.analyseCompact(env.goal, env.base);
  say(`EXAPT Analysis: ${analysis.status}. ${analysis.summary}`);
  const gap = analysis.gaps[0];
  if (gap) say(`Detected Gap: ${gap.title}`);

  heading("4. Adversarial Falsification: Attack with Negative Controls");
  const controls = negativeControls(env.pageSize);
  say(`Submitting ${controls.length} classic AI hallucination patterns to EXAPT's Docker containment boundary:`);
  for (const c of controls) say(`  - ${c.name}: ${c.fault}`);

  // Inject negative controls alongside synthesis
  const run = await exapt.startInvention(env.goal, env.base, {
    seed,
    injected: controls.map((c) => c.candidate),
  });

  printAttempts(run);
  const escaped = run.attempts.filter((x) => x.candidate.kind === "injected-control" && x.survived);
  const controlsRun = controls.every(c => run.attempts.some(a => a.candidate.producer === c.candidate.producer));
  if (controlsRun && escaped.length === 0) {
    good("All negative controls (x86 4KB hallucination, unstripped dots, broken conservation) were intercepted and FALSIFIED!");
  } else {
    bad(controlsRun ? `${escaped.length} negative controls escaped falsification!` : "Some negative controls were not exercised; this run cannot pass.");
  }

  say(synthesisLine(run));

  heading("5. Independent Assessment of the Synthesized Capability");
  printEvidence(run);

  heading("6. Execution Across Held-Out Host Snapshots");
  let matchedHeldOut = 0;
  const totalHeldOut = 6;
  if (run.capability?.status === "verified-within-scope") {
    // Generate synthetic varied load snapshots
    for (let i = 0; i < totalHeldOut; i++) {
      const free = 5000 + i * 1234;
      const active = 150000 + i * 5000;
      const inactive = 400000 - i * 3000;
      const spec = 2000 + i * 100;
      const wired = 250000 + i * 2000;
      const comp = 400000 + i * 4000;
      const testVmStat = `Mach Virtual Memory Statistics: (page size of ${env.pageSize} bytes)
Pages free:                                     ${free}.
Pages active:                                 ${active}.
Pages inactive:                               ${inactive}.
Pages speculative:                              ${spec}.
Pages throttled:                                   0.
Pages wired down:                             ${wired}.
Pages purgeable:                                   2.
"Translation faults":                     ${1000000000 + i * 1000}.
Pages copy-on-write:                        ${10000000 + i * 100}.
Pages zero filled:                         ${500000000 + i * 500}.
Pages reactivated:                         ${200000000 + i * 200}.
Pages purged:                                ${5000000 + i * 50}.
File-backed pages:                             ${50000 + i * 1000}.
Anonymous pages:                              ${300000 + i * 2000}.
Pages stored in compressor:                   ${comp * 2}.
Pages occupied by compressor:                 ${comp}.
Decompressions:                             ${10000000 + i * 100}.
Compressions:                               ${20000000 + i * 200}.
Pageins:                                      ${500000 + i * 50}.
Pageouts:                                      ${10000 + i * 10}.
Swapins:                                       ${20000 + i * 20}.
Swapouts:                                      ${30000 + i * 30}.
`;
      try {
        const converted = await exapt.use(run.capability.id, testVmStat);
        const expected = referenceAdapter(testVmStat, env.pageSize);
        const syntax = sniffSyntax(expected);
        const cmp = compareRecords(parseRecords(expected, syntax), parseRecords(converted.output, syntax));
        if (cmp.equal) matchedHeldOut++;
      } catch {
        /* mismatch */
      }
    }
    if (matchedHeldOut === totalHeldOut) {
      good(`${matchedHeldOut}/${totalHeldOut} held-out kernel telemetry snapshots passed with exact invariant agreement`);
    } else {
      bad(`${matchedHeldOut}/${totalHeldOut} held-out snapshots passed`);
    }
  }

  heading("7. Live Darwin Telemetry Ingestion");
  let liveReport = "";
  let liveMemoryGb = "";
  if (run.capability?.status === "verified-within-scope") {
    const liveVmStat = execSync("/usr/bin/vm_stat", { encoding: "utf8" });
    const t0 = performance.now();
    const liveConverted = await exapt.use(run.capability.id, liveVmStat);
    const ms = Math.round(performance.now() - t0);

    // Pipe directly into the strict consumer
    const ingested = await collectorTool.run(liveConverted.output);
    if (accepted(ingested)) {
      good(`Live kernel telemetry successfully ingested in ${ms}ms with zero model tokens:`);
      say(ingested.stdout.trim());
      liveReport = ingested.stdout.trim();
      const match = liveReport.match(/Selected metrics total: ([\d.]+) GiB/);
      if (match) liveMemoryGb = match[1];
    } else {
      bad(`Collector rejected live conversion: ${ingested.stderr}`);
    }
  }

  const ok = controlsRun && escaped.length === 0 && !accepted(directRun) && matchedHeldOut === totalHeldOut && !!liveReport;
  const report = saveReport(dir, "demo4-telemetry-report", {
    seed,
    pageSize: env.pageSize,
    controls: controls.map((c) => ({
      name: c.name,
      fault: c.fault,
      rejected: run.attempts.some((x) => x.candidate.producer === c.candidate.producer && !x.survived),
    })),
    synthesis: run.synthesis,
    capability: run.capability,
    heldOut: { matched: matchedHeldOut, total: totalHeldOut },
    liveReport,
  });

  console.log(`\n${ok ? "\x1b[32mDemonstration 4 passed.\x1b[0m" : "\x1b[31mDemonstration 4 did not pass.\x1b[0m"} Report: ${report}`);
  await exapt.host.rc.flush();
  return { ok, dir, report, capability: run.capability?.id, liveMemoryGb };
}

// Allow direct execution: node demos/invariant-telemetry/run.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  demo4().then((r) => process.exit(r.ok ? 0 : 1));
}
