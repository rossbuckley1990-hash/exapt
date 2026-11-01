import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { continuityFixture, runContinuity } from "../demos/continuity/run.ts";
import { sandboxSkip, tempDir } from "./support.ts";

test("Continuity reserves three real files for the outage drill", () => {
  const { goal, drills } = continuityFixture();
  assert.equal(goal.corpus!.length, 7);
  assert.equal(drills.length, 3);
  assert.ok(drills.every((d) => !goal.corpus!.some((c) => c.name === d.name)));
});

test("Continuity restores exact records with no original host programs", { skip: sandboxSkip }, async () => {
  const result = await runContinuity({ dir: tempDir("continuity"), seed: 3 });
  const report = JSON.parse(fs.readFileSync(result.report, "utf8")) as {
    preLoss: { modelCalls: number };
    outage: { hostPrograms: number; exactFiles: number; tamperRefused: boolean };
  };
  assert.equal(result.ok, true, fs.readFileSync(result.report, "utf8"));
  assert.equal(report.preLoss.modelCalls, 0);
  assert.equal(report.outage.hostPrograms, 0);
  assert.equal(report.outage.exactFiles, 3);
  assert.equal(report.outage.tamperRefused, true);
});
