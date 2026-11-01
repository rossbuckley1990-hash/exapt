// Real macOS Darwin kernel telemetry environment: vm_stat -> telemetry-collector.
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Goal } from "../../packages/capability-universe/index.ts";

export interface TelemetryEnv {
  dir: string;
  base: string;
  programs: string;
  collector: string;
  samplePath: string;
  targetSamplePath: string;
  goal: Goal;
  pageSize: number;
}

export function generateVmStat(pageSize: number, free: number, active: number, inactive: number, spec: number, wired: number, comp: number): string {
  return `Mach Virtual Memory Statistics: (page size of ${pageSize} bytes)
Pages free:                                     ${free}.
Pages active:                                 ${active}.
Pages inactive:                               ${inactive}.
Pages speculative:                              ${spec}.
Pages throttled:                                   0.
Pages wired down:                             ${wired}.
Pages purgeable:                                   4.
"Translation faults":                     1234567890.
Pages copy-on-write:                        12345678.
Pages zero filled:                         987654321.
Pages reactivated:                          45678901.
Pages purged:                                1234567.
File-backed pages:                             98765.
Anonymous pages:                              345678.
Pages stored in compressor:                   ${comp * 2}.
Pages occupied by compressor:                 ${comp}.
Decompressions:                             12345678.
Compressions:                               15678901.
Pageins:                                     1234567.
Pageouts:                                      12345.
Swapins:                                       45678.
Swapouts:                                      56789.
`;
}

export function writeTelemetryEnvironment(dir: string): TelemetryEnv {
  fs.mkdirSync(dir, { recursive: true });
  const programs = path.join(dir, "programs");
  fs.mkdirSync(programs, { recursive: true });
  // Node must not search outside the authorised program directory for package metadata.
  fs.writeFileSync(path.join(programs, "package.json"), '{"type":"module"}\n');

  // Detect true host page size (16384 on Apple Silicon, 4096 on x86)
  if (process.platform !== "darwin") throw new Error("Demonstration 4 requires macOS; no synthetic fallback is presented as live telemetry.");
  const pageSize = Number(execSync("sysctl -n hw.pagesize", { encoding: "utf8" }).trim());
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) throw new Error("Host page size could not be established");

  // Generate real sample from host vm_stat or realistic variation
  const liveVmStat = execSync("/usr/bin/vm_stat", { encoding: "utf8" });

  const samplePath = path.join(dir, "sample-vmstat.txt");
  fs.writeFileSync(samplePath, liveVmStat, "utf8");

  const targetSample = referenceAdapter(liveVmStat, pageSize);
  const targetSamplePath = path.join(dir, "sample-target.ndjson");
  fs.writeFileSync(targetSamplePath, targetSample, "utf8");

  // Create training corpus pairs for EXAPT's CEGIS engine
  const corpusDir = path.join(dir, "corpus");
  fs.mkdirSync(corpusDir, { recursive: true });

  const corpusPairs: Array<{ name: string; input: { path: string }; truth: { path: string } }> = [];
  const corpusConfigs = [
    { name: "snap-idle", free: 12000, active: 140000, inactive: 380000, spec: 3000, wired: 220000, comp: 350000 },
    { name: "snap-active", free: 6000, active: 180000, inactive: 350000, spec: 1500, wired: 270000, comp: 420000 },
    { name: "snap-heavy", free: 4000, active: 200000, inactive: 320000, spec: 1000, wired: 300000, comp: 480000 },
    ...Array.from({ length: 9 }, (_, i) => ({ name: `audit-snapshot-${i}`, free: i === 0 ? 0 : 1 + i * 941, active: 157003 + i * 1303, inactive: 230009 + i * 1709, spec: 3 + i * 11, wired: 197003 + i * 1049, comp: 181001 + i * 1301 })),
  ];

  for (const c of corpusConfigs) {
    const inputTxt = generateVmStat(pageSize, c.free, c.active, c.inactive, c.spec, c.wired, c.comp);
    const truthTxt = referenceAdapter(inputTxt, pageSize);
    const inPath = path.join(corpusDir, `${c.name}.input.txt`);
    const outPath = path.join(corpusDir, `${c.name}.truth.ndjson`);
    fs.writeFileSync(inPath, inputTxt, "utf8");
    fs.writeFileSync(outPath, truthTxt, "utf8");
    corpusPairs.push({
      name: c.name,
      input: { path: path.relative(dir, inPath) },
      truth: { path: path.relative(dir, outPath) },
    });
  }

  // Example valid text for docSamples
  const docSampleLines = [
    JSON.stringify({ metric: "memory.free_bytes", value: 8192 * pageSize }),
    JSON.stringify({ metric: "memory.active_bytes", value: 163840 * pageSize }),
    JSON.stringify({ metric: "memory.inactive_bytes", value: 327680 * pageSize }),
    JSON.stringify({ metric: "memory.speculative_bytes", value: 2048 * pageSize }),
    JSON.stringify({ metric: "memory.wired_bytes", value: 262144 * pageSize }),
    JSON.stringify({ metric: "memory.compressor_bytes", value: 262144 * pageSize }),
  ].join("\n");

  // Write strict consumer program: kernel-telemetry-collector
  const collectorScript = `#!/usr/bin/env node
import fs from 'node:fs';

const EXPECTED_PAGE_SIZE = ${pageSize};
const REQUIRED_METRICS = [
  'memory.free_bytes',
  'memory.active_bytes',
  'memory.inactive_bytes',
  'memory.speculative_bytes',
  'memory.wired_bytes',
  'memory.compressor_bytes'
];

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(\`usage: kernel-telemetry-collector

Reads normalized Mach VM telemetry from standard input as newline-delimited JSON.
Validates metric naming, exact byte scaling against hardware page size (\${EXPECTED_PAGE_SIZE} bytes),
and requires all six selected metrics. This is a schema check, not a physical conservation proof.

Example input:
${docSampleLines.split("\n").map(l => "  " + l).join("\n")}
\`);
  process.exit(0);
}

if (process.argv.includes('--version')) {
  console.log('kernel-telemetry-collector 1.0.0');
  process.exit(0);
}

const input = fs.readFileSync(0, 'utf8').trim();
if (!input) {
  console.error('empty input: expected NDJSON metrics');
  process.exit(2);
}

const lines = input.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
if (lines.length === 0) {
  console.error('no metric records found');
  process.exit(2);
}

const metrics = new Map();
let totalBytes = 0;

for (let i = 0; i < lines.length; i++) {
  let record;
  try {
    record = JSON.parse(lines[i]);
  } catch (err) {
    console.error(\`line \${i + 1}: invalid JSON\`);
    process.exit(1);
  }

  const { metric, value } = record;
  if (!metric || typeof metric !== 'string') {
    console.error(\`line \${i + 1}: missing or invalid metric name\`);
    process.exit(1);
  }

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    console.error(\`line \${i + 1}: value must be a non-negative integer in bytes (got \${value})\`);
    process.exit(1);
  }

  // Exact hardware scale validation: value must be a multiple of EXPECTED_PAGE_SIZE
  if (value % EXPECTED_PAGE_SIZE !== 0) {
    console.error(\`line \${i + 1}: invalid byte scale for \${metric}: \${value} bytes is not a multiple of \${EXPECTED_PAGE_SIZE}B/page\`);
    process.exit(1);
  }

  metrics.set(metric, value);
  totalBytes += value;
}

// Invariant Check: Verify all required metrics are present
for (const req of REQUIRED_METRICS) {
  if (!metrics.has(req)) {
    console.error(\`missing required telemetry metric: \${req}\`);
    process.exit(1);
  }
}

const managedGb = (totalBytes / (1024 * 1024 * 1024)).toFixed(2);
console.log(\`OK: kernel-telemetry-collector ingested \${metrics.size} metrics. Selected metrics total: \${managedGb} GiB (@ \${EXPECTED_PAGE_SIZE}B/page)\`);
process.exit(0);
`;

  const collectorPath = path.join(programs, "kernel-telemetry-collector");
  fs.writeFileSync(collectorPath, collectorScript, { mode: 0o755 });
  fs.chmodSync(collectorPath, 0o755);

  const goal: Goal = {
    id: "darwin-kernel-telemetry-induction",
    intent: "Convert raw Darwin Mach VM telemetry to six named NDJSON metrics with exact page-to-byte conversions; inputs have a valid header and unique statistic labels",
    have: {
      samples: [{ path: "sample-vmstat.txt" }],
      description: "Raw /usr/bin/vm_stat text output with hardware page size header and trailing-dot formatted page counts",
    },
    want: {
      program: "kernel-telemetry-collector",
      sample: { path: "sample-target.ndjson" },
      description: "NDJSON metrics with keys {metric, value} in bytes, checked against independent expected values",
    },
    corpus: corpusPairs,
  };

  return {
    dir,
    base: dir,
    programs,
    collector: "kernel-telemetry-collector",
    samplePath,
    targetSamplePath,
    goal,
    pageSize,
  };
}

export function referenceAdapter(vmStatText: string, pageSize: number): string {
  const lines = vmStatText.trim().split(/\r?\n/);
  const headerMatch = lines[0].match(/page size of (\d+) bytes/);
  const actualPageSize = headerMatch ? parseInt(headerMatch[1], 10) : pageSize;

  const mapping: Record<string, string> = {
    "Pages free:": "memory.free_bytes",
    "Pages active:": "memory.active_bytes",
    "Pages inactive:": "memory.inactive_bytes",
    "Pages speculative:": "memory.speculative_bytes",
    "Pages wired down:": "memory.wired_bytes",
    "Pages occupied by compressor:": "memory.compressor_bytes",
  };

  const records: Array<{ metric: string; value: number }> = [];

  for (const line of lines.slice(1)) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const label = line.slice(0, colon + 1).trim();
    const metricName = mapping[label];
    if (metricName) {
      const valStr = line.slice(colon + 1).replace(/\./g, "").trim();
      const pages = parseInt(valStr, 10);
      if (!Number.isFinite(pages)) continue;
      records.push({
        metric: metricName,
        value: pages * actualPageSize,
      });
    }
  }

  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}
