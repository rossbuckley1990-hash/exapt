// The release decision. EXAPT's own test results are read by a capability EXAPT acquired: a real agent
// with no shell built it, and it arrives here as a portable bundle that must prove itself on this
// host before it may do anything. Its counts are then checked against Node's JUnit reporter from the
// same run, so the gate does not rest on the capability alone.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configFromEnv, Exapt } from "../packages/protocol/engine.ts";
import { pool, writeJson } from "../packages/shared/index.ts";
import type { CapabilityBundle } from "../packages/capability-memory/index.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exapt-gate-")));
const gates: Array<{ gate: string; passed: boolean; detail: string }> = [];
const gate = (name: string, passed: boolean, detail: string) => {
  gates.push({ gate: name, passed, detail });
  console.log(`${passed ? "pass" : "FAIL"}  ${name}: ${detail}`);
};

const tsc = spawnSync(path.join(ROOT, "node_modules/.bin/tsc"), ["-p", "tsconfig.json"], { cwd: ROOT, encoding: "utf8" });
gate("type check", tsc.status === 0, tsc.status === 0 ? "clean" : tsc.stdout.slice(0, 300));

const engine = await Exapt.open(configFromEnv(process.env, { home: path.join(work, "home"), programs: [], model: null }));
const doctor = await engine.doctor();
gate("host and containment", doctor.ok, doctor.ok ? `${doctor.selfTest?.checks.filter((c) => c.passed).length ?? 0} sandbox attacks contained` : doctor.checks.filter((c) => c.status === "fail").map((c) => `${c.name}: ${c.detail}`).join("; "));

const bundle = JSON.parse(fs.readFileSync(path.join(ROOT, "capabilities/node-test-results.bundle.json"), "utf8")) as CapabilityBundle;
const imported = await engine.importCapability(bundle);
const capability = imported.manifest.id;
gate("capability re-proved on this host", imported.revalidation.outcome === "accepted-import", `${capability}: ${imported.revalidation.checks.passed}/${imported.revalidation.checks.total} checks reproduced`);

const only = process.argv.slice(2);
const files = fs.readdirSync(path.join(ROOT, "test")).filter((f) => f.endsWith(".test.ts") && (!only.length || only.some((o) => f.includes(o)))).sort();
const runFile = (file: string) => new Promise<{ file: string; tap: string; xml: string }>((done) => {
  const [tap, xml] = [".tap", ".xml"].map((e) => path.join(work, file + e));
  const p = spawn(process.execPath, ["--test", "--test-timeout=280000", "--test-reporter=tap", `--test-reporter-destination=${tap}`, "--test-reporter=junit", `--test-reporter-destination=${xml}`, path.join("test", file)], { cwd: ROOT, stdio: "ignore" });
  p.on("close", () => done({ file, tap, xml }));
});
const runs = await pool(files, 3, runFile);
const rows: Array<{ file: string; suite: string; name: string; status: string }> = [];
const disagreements: string[] = [];
for (const r of runs) {
  const out = await engine.use(capability, fs.readFileSync(r.tap, "utf8"));
  const tests = out.output.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as { suite: string; name: string; status: string });
  rows.push(...tests.map((t) => ({ file: r.file, ...t })));
  const junit = (fs.readFileSync(r.xml, "utf8").match(/<testcase /g) ?? []).length;
  if (junit !== tests.length) disagreements.push(`${r.file}: capability ${tests.length}, JUnit ${junit}`);
}
gate("capability agrees with Node's JUnit reporter", disagreements.length === 0, disagreements.length ? disagreements.join("; ") : `${files.length} files`);
const count = (s: string) => rows.filter((r) => r.status === s).length;
const failed = rows.filter((r) => r.status === "fail");
gate("test suite", failed.length === 0 && rows.length > 0, `${count("pass")} passed, ${failed.length} failed, ${count("skip")} skipped, ${count("todo")} todo`);
for (const f of failed.slice(0, 20)) console.log(`      failed: ${f.file}: ${f.suite ? `${f.suite} > ` : ""}${f.name}`);

const ready = gates.every((g) => g.passed);
const report = { decision: ready ? "release candidate" : "not ready", at: new Date().toISOString(), node: process.version, capability: { id: capability, version: imported.manifest.version, producer: imported.manifest.provenance.producer }, gates, failed };
if (!only.length) writeJson(path.join(ROOT, "docs/RELEASE-GATE.json"), report);
console.log(`\n${report.decision}`);
await engine.host.rc.flush();
fs.rmSync(work, { recursive: true, force: true });
process.exit(ready ? 0 : 1);
