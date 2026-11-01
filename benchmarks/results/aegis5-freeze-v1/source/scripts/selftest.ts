// Attack the execution boundary and print what happened.
import { DockerBackend, selfTest } from "../packages/execution/index.ts";
const report = await selfTest(new DockerBackend());
for (const c of report.checks) console.log(`${c.passed ? "pass" : "FAIL"}  ${c.name}  [${c.detail}]`);
for (const f of report.failures) console.log(`failure: ${f}`);
process.exit(report.ok ? 0 : 1);
