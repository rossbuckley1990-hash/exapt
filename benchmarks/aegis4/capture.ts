// Preserve the original development attempts before any replication or stronger tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const destination = path.resolve(process.argv[2] ?? 'benchmarks/results/aegis4-originals');
if (fs.existsSync(destination)) throw new Error('Refusing to replace an existing capture');
fs.mkdirSync(destination, { recursive: true });
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
const inventory: Array<{ path: string; bytes: number; sha256: string }> = [];
const walk = (dir: string) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) { const bytes = fs.readFileSync(file); inventory.push({ path: path.relative(destination, file), bytes: bytes.length, sha256: sha(bytes) }); }
    else throw new Error(`Unexpected non-file in capture: ${file}`);
  }
};
const attempts = [];
for (const name of fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('exapt-demo4-invariant-telemetry-')).sort()) {
  const original = path.join(os.tmpdir(), name);
  if (!fs.existsSync(path.join(original, 'demo4-telemetry-report.json'))) continue;
  fs.cpSync(original, path.join(destination, name), { recursive: true });
  const runs = path.join(original, '.exapt/runs');
  for (const id of fs.readdirSync(runs)) {
    const run = JSON.parse(fs.readFileSync(path.join(runs, id, 'run.json'), 'utf8'));
    const log = path.join(runs, id, 'model.jsonl');
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(s => JSON.parse(s)) : [];
    attempts.push({ directory: name, id, status: run.status, outcome: run.outcome, accepted: run.accepted, evidence: run.evidence,
      costUsdReported: calls.reduce((n, c) => n + (c.usage?.costUsd ?? 0), 0), modelCallsRecorded: calls.length,
      inputTokens: calls.reduce((n,c) => n+(c.usage?.inputTokens ?? 0),0), outputTokens: calls.reduce((n,c) => n+(c.usage?.outputTokens ?? 0),0),
      transcriptAvailable: calls.length ? calls.every(c => typeof c.prompt === 'string' && typeof c.reply === 'string') : null });
  }
}
walk(destination);
const report = { capturedAt: new Date().toISOString(), attempts,
  reportedCostUsd: attempts.reduce((n,r) => n+r.costUsdReported,0),
  sourceProvenance: { originalRunSourceRevision: 'NOT RECORDED; cannot reconstruct exact dirty checkout', currentHead: spawnSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).stdout.trim() },
  limitations: ['Metadata and extracted source cannot recover a missing full model transcript.', 'Historical containment claims require present-day reproduction; flags in a report are not attestation.'], inventory };
fs.writeFileSync(path.join(destination,'inventory.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({destination,attempts:attempts.length,reportedCostUsd:report.reportedCostUsd,files:inventory.length},null,2));
