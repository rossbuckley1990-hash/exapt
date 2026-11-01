// A procedurally generated toolchain with a hole in it. Every program is a real, independently
// usable executable. Field names, delimiters, units and encodings are drawn from the seed, so no
// adapter written in advance could fit, and the transformation between the exporter's format and
// the ingester's format exists nowhere in this environment until EXAPT constructs it.
import fs from "node:fs";
import path from "node:path";
import { Rng } from "../../packages/shared/index.ts";
import type { Goal } from "../../packages/capability-universe/index.ts";

export interface Conversion {
  name: string;
  /** Target = a * source + b, rounded to `places`. */
  a: number;
  b: number;
  places: number;
  sourcePlaces: number;
  sourceUnit: string;
  targetUnit: string;
  range: [number, number];
}

const CONVERSIONS: Conversion[] = [
  { name: "fahrenheit-to-celsius", a: 5 / 9, b: -160 / 9, places: 2, sourcePlaces: 3, sourceUnit: "degrees Fahrenheit", targetUnit: "degrees Celsius", range: [5, 95] },
  { name: "kelvin-to-celsius", a: 1, b: -273.15, places: 2, sourcePlaces: 2, sourceUnit: "kelvin", targetUnit: "degrees Celsius", range: [263, 310] },
  { name: "dollars-to-cents", a: 100, b: 0, places: 0, sourcePlaces: 2, sourceUnit: "dollars", targetUnit: "cents", range: [1, 900] },
  { name: "percent-to-ratio", a: 0.01, b: 0, places: 3, sourcePlaces: 1, sourceUnit: "percent", targetUnit: "a ratio between 0 and 1", range: [1, 99] },
  { name: "metres-to-millimetres", a: 1000, b: 0, places: 0, sourcePlaces: 3, sourceUnit: "metres", targetUnit: "millimetres", range: [1, 40] },
];

const SOURCE_ID = ["device", "unit_name", "asset", "node", "tag"];
const SOURCE_TIME = ["reading_time", "captured_at", "observed", "stamp", "logged_at"];
const SOURCE_VALUE = ["measure", "reading", "level", "value_raw", "sample"];
const SOURCE_NOTE = ["site_label", "zone", "bay", "group_name", "lane"];
const TARGET_ID = ["unit", "asset_id", "source", "origin", "ident"];
const TARGET_TIME = ["epoch_s", "ts", "unix_time", "at_seconds", "time_s"];
const TARGET_VALUE = ["metric", "val", "quantity", "amount", "norm_value"];
const TARGET_NOTE = ["site", "location", "area", "zone_code", "sector"];
const THEMES = ["cold", "fleet", "grid", "mill", "port", "dock", "vault"];
const DELIMITERS = [";", "|", "\t", ","];

export interface Params {
  seed: number;
  theme: string;
  delimiter: string;
  conversion: Conversion;
  idTransform: "same" | "strip-prefix";
  source: { id: string; time: string; value: string; note: string };
  target: { id: string; time: string; value: string; note: string };
  programs: { exporter: string; ingester: string; reporter: string; archiver: string };
}

export function paramsFor(seed: number): Params {
  const r = new Rng(seed * 7919 + 13);
  const theme = r.pick(THEMES);
  return {
    seed, theme, delimiter: r.pick(DELIMITERS), conversion: r.pick(CONVERSIONS), idTransform: r.pick(["same", "strip-prefix"] as const),
    source: { id: r.pick(SOURCE_ID), time: r.pick(SOURCE_TIME), value: r.pick(SOURCE_VALUE), note: r.pick(SOURCE_NOTE) },
    target: { id: r.pick(TARGET_ID), time: r.pick(TARGET_TIME), value: r.pick(TARGET_VALUE), note: r.pick(TARGET_NOTE) },
    programs: { exporter: `${theme}-export`, ingester: `${theme}-ingest`, reporter: `${theme}-report`, archiver: `${theme}-archive` },
  };
}

const helper = `
const fs = require('fs');
const args = process.argv.slice(2);
const read = () => fs.readFileSync(0, 'utf8');
const lines = (t) => t.split(/\\r?\\n/).filter((l) => l.trim() !== '');
const fail = (m) => { process.stderr.write(m + '\\n'); process.exit(3); };
`;

function program(body: string, help: string, version: string): string {
  return `#!/usr/bin/env node
${helper}
const HELP = ${JSON.stringify(help)};
if (args.includes('--help') || args.includes('-h')) { process.stdout.write(HELP); process.exit(0); }
if (args.includes('--version')) { process.stdout.write(${JSON.stringify(version)} + '\\n'); process.exit(0); }
${body}
`;
}

const idFor = (p: Params, v: string) => (p.idTransform === "strip-prefix" ? v.replace(/^rig-/, "") : v);

export function buildPrograms(p: Params): Record<string, string> {
  const { source: s, target: t, conversion: c, delimiter: d } = p;
  const dl = JSON.stringify(d);
  const dName = d === "\t" ? "tab" : d;
  const exporter = program(`
const rows = lines(read()).map((l, i) => {
  const m = /^(\\S+) @(\\d{10}) v=(-?\\d+(?:\\.\\d+)?) n=(\\S+)$/.exec(l);
  if (!m) fail('line ' + (i + 1) + ': expected "<id> @<unix> v=<number> n=<note>"');
  return m;
});
const out = [[${JSON.stringify(s.id)}, ${JSON.stringify(s.time)}, ${JSON.stringify(s.value)}, ${JSON.stringify(s.note)}].join(${dl})];
for (const m of rows) out.push([m[1], new Date(Number(m[2]) * 1000).toISOString().replace('.000Z', 'Z'), Number(m[3]).toFixed(${c.sourcePlaces}), m[4]].join(${dl}));
process.stdout.write(out.join('\\n') + '\\n');
`, `usage: ${p.programs.exporter}

Reads a raw device dump from standard input and writes the site export.

Each input line is:  <id> @<unix-seconds> v=<number> n=<note>

Example input:
  rig-${p.seed}-a @1772619300 v=${(c.range[0] + 7).toFixed(1)} n=North-Wing
  rig-${p.seed}-b @1772619360 v=${(c.range[0] + 9).toFixed(1)} n=East-Wing

The export is a ${dName}-delimited table with a header. The value column is in ${c.sourceUnit}.
`, `${p.programs.exporter} 1.0.0`);

  const ingester = program(`
const totals = new Map();
for (const [i, l] of lines(read()).entries()) {
  let r;
  try { r = JSON.parse(l); } catch { fail('line ' + (i + 1) + ': not a JSON object'); }
  for (const k of [${JSON.stringify(t.id)}, ${JSON.stringify(t.time)}, ${JSON.stringify(t.value)}, ${JSON.stringify(t.note)}]) if (!(k in r)) fail('line ' + (i + 1) + ': missing ' + k);
  if (typeof r[${JSON.stringify(t.value)}] !== 'number' || !Number.isFinite(r[${JSON.stringify(t.value)}])) fail('line ' + (i + 1) + ': ' + ${JSON.stringify(t.value)} + ' must be a number');
  if (!Number.isInteger(r[${JSON.stringify(t.time)}]) || r[${JSON.stringify(t.time)}] < 1e9) fail('line ' + (i + 1) + ': ' + ${JSON.stringify(t.time)} + ' must be integer unix seconds');
  const key = r[${JSON.stringify(t.note)}] + '/' + r[${JSON.stringify(t.id)}];
  const e = totals.get(key) ?? { n: 0, sum: 0, max: -Infinity, first: Infinity, last: -Infinity };
  e.n++; e.sum += r[${JSON.stringify(t.value)}]; e.max = Math.max(e.max, r[${JSON.stringify(t.value)}]);
  e.first = Math.min(e.first, r[${JSON.stringify(t.time)}]); e.last = Math.max(e.last, r[${JSON.stringify(t.time)}]);
  totals.set(key, e);
}
const keys = [...totals.keys()].sort();
if (!keys.length) fail('no readings');
process.stdout.write(['key\\treadings\\tmean\\tmax\\tspan_s', ...keys.map((k) => { const e = totals.get(k); return [k, e.n, (e.sum / e.n).toFixed(3), e.max.toFixed(3), e.last - e.first].join('\\t'); })].join('\\n') + '\\n');
`, `usage: ${p.programs.ingester}

Reads readings from standard input as newline-delimited JSON, one object per
reading, and writes a tab-separated summary per location and unit.

Each object has:
  ${t.id}  string   unit identifier
  ${t.time}  integer  seconds since 1970-01-01
  ${t.value}  number   measured value in ${c.targetUnit}
  ${t.note}  string   location code

Example input:
  {"${t.id}":"${idFor(p, "rig-1a")}","${t.time}":1772619300,"${t.value}":${(c.a * c.range[0] + c.b + 3).toFixed(Math.max(c.places, 1))},"${t.note}":"North-Wing"}
  {"${t.id}":"${idFor(p, "rig-2b")}","${t.time}":1772619360,"${t.value}":${(c.a * c.range[0] + c.b + 4).toFixed(Math.max(c.places, 1))},"${t.note}":"East-Wing"}
`, `${p.programs.ingester} 2.3.1`);

  const threshold = c.a * ((c.range[0] + c.range[1]) / 2) + c.b;
  const reporter = program(`
const ls = lines(read());
if (!ls.length || ls[0] !== 'key\\treadings\\tmean\\tmax\\tspan_s') fail('expected a summary table with header key, readings, mean, max, span_s');
const out = [];
for (const l of ls.slice(1)) {
  const [key, n, mean, max, span] = l.split('\\t');
  if (!key || !Number.isFinite(Number(mean))) fail('bad row: ' + l);
  out.push(key + ': ' + (Number(max) > ${threshold} ? 'OVER LIMIT' : 'WITHIN LIMIT') + ' mean=' + mean + ' over ' + n + ' readings in ' + span + 's');
}
process.stdout.write(out.join('\\n') + '\\n');
`, `usage: ${p.programs.reporter}

Reads the summary written by ${p.programs.ingester} from standard input and prints
a compliance line per location. A location is over limit when its maximum
exceeds ${threshold.toFixed(2)}.
`, `${p.programs.reporter} 1.1.0`);

  const invA = 1 / c.a;
  const invB = -c.b / c.a;
  const archiver = program(`
const out = [[${JSON.stringify(s.id)}, ${JSON.stringify(s.time)}, ${JSON.stringify(s.value)}, ${JSON.stringify(s.note)}].join(${dl})];
for (const [i, l] of lines(read()).entries()) {
  let r;
  try { r = JSON.parse(l); } catch { fail('line ' + (i + 1) + ': not a JSON object'); }
  const v = r[${JSON.stringify(t.value)}], ts = r[${JSON.stringify(t.time)}];
  if (typeof v !== 'number' || !Number.isInteger(ts) || !(${JSON.stringify(t.id)} in r) || !(${JSON.stringify(t.note)} in r)) fail('line ' + (i + 1) + ': incomplete reading');
  out.push([${p.idTransform === "strip-prefix" ? "'rig-' + " : ""}r[${JSON.stringify(t.id)}], new Date(ts * 1000).toISOString().replace('.000Z', 'Z'), (v * ${invA} + ${invB}).toFixed(${c.sourcePlaces}), r[${JSON.stringify(t.note)}]].join(${dl}));
}
process.stdout.write(out.join('\\n') + '\\n');
`, `usage: ${p.programs.archiver}

Writes readings back out in the legacy site table for long-term storage.
Reads the same newline-delimited JSON as ${p.programs.ingester} from standard input.

Example input:
  {"${t.id}":"${idFor(p, "rig-1a")}","${t.time}":1772619300,"${t.value}":${(c.a * c.range[0] + c.b + 3).toFixed(Math.max(c.places, 1))},"${t.note}":"North-Wing"}
`, `${p.programs.archiver} 0.9.4`);

  const counter = program(`process.stdout.write(lines(read()).length + ' lines\\n');`, "usage: tally\n\nCounts the non-empty lines on standard input.\n\nExample input:\n  one line\n  another line\n", "tally 1.0.0");
  const shout = program(`process.stdout.write(read().toUpperCase());`, "usage: shout\n\nUpper-cases standard input.\n\nExample input:\n  quiet words\n", "shout 1.0.0");
  return { [p.programs.exporter]: exporter, [p.programs.ingester]: ingester, [p.programs.reporter]: reporter, [p.programs.archiver]: archiver, tally: counter, shout };
}

/** Raw dump lines; the caller's input to the workflow. */
export function rawDump(p: Params, seed: number, rows: number): string {
  const r = new Rng(seed);
  const notes = ["North-Wing", "East-Wing", "Cold-Store", "Dock-Seven", "Roof-Plant"];
  const out: string[] = [];
  for (let i = 0; i < rows; i++) {
    const v = r.int(p.conversion.range[0] * 10, p.conversion.range[1] * 10) / 10;
    out.push(`rig-${r.int(1, 9)}${r.pick(["a", "b", "c"])} @${1772000000 + r.int(0, 9_000_000)} v=${v} n=${r.pick(notes)}`);
  }
  return `${out.join("\n")}\n`;
}

/** The reference transformation, kept out of the environment and used only to score the result. */
export function referenceAdapter(p: Params, exported: string): string {
  const ls = exported.trim().split("\n").slice(1);
  return ls.map((l) => {
    const [id, time, value, note] = l.split(p.delimiter);
    const c = p.conversion;
    const v = Number((c.a * Number(value) + c.b).toFixed(c.places));
    return JSON.stringify({ [p.target.id]: idFor(p, id), [p.target.time]: Date.parse(time) / 1000, [p.target.value]: v, [p.target.note]: note });
  }).join("\n") + "\n";
}

export interface Environment {
  params: Params;
  dir: string;
  programs: string;
  goal: Goal;
  base: string;
}

/** A further consumer two transformations away, so a second invention can stand on the first. */
export function buildSecondStage(p: Params): Record<string, string> {
  const t = p.target;
  const ledger = program(`
const blocks = read().trim().split(/\\n\\s*\\n/);
const out = [];
for (const b of blocks) {
  const r = Object.fromEntries(b.split('\\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  for (const k of ['who', 'when', 'level']) if (!(k in r)) fail('missing ' + k);
  if (!Number.isFinite(Number(r.level))) fail('level must be a number');
  out.push(r.who + ' ' + Number(r.level).toFixed(2));
}
process.stdout.write(out.sort().join('\\n') + '\\n');
`, `usage: ${p.theme}-ledger

Reads ledger blocks from standard input, separated by blank lines, and prints one
sorted line per block.

Example input:
  who: rig-1
  when: 1772619300
  level: 4.25

  who: rig-2
  when: 1772619360
  level: 7.50
`, `${p.theme}-ledger 1.0.0`);
  const unledger = program(`
const blocks = read().trim().split(/\\n\\s*\\n/);
const out = [];
for (const b of blocks) {
  const r = Object.fromEntries(b.split('\\n').map((l) => { const i = l.indexOf(':'); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; }));
  if (!('who' in r) || !('when' in r) || !('level' in r)) fail('incomplete block');
  out.push(JSON.stringify({ ${JSON.stringify(t.id)}: r.who, ${JSON.stringify(t.time)}: Number(r.when), ${JSON.stringify(t.value)}: Number(r.level), ${JSON.stringify(t.note)}: 'unassigned' }));
}
process.stdout.write(out.join('\\n') + '\\n');
`, `usage: ${p.theme}-unledger

Turns ledger blocks back into newline-delimited readings for reprocessing.

Example input:
  who: rig-1
  when: 1772619300
  level: 4.25
`, `${p.theme}-unledger 1.0.0`);
  return { [`${p.theme}-ledger`]: ledger, [`${p.theme}-unledger`]: unledger };
}

export function writeEnvironment(seed: number, dir: string, opts: { secondStage?: boolean } = {}): Environment {
  const params = paramsFor(seed);
  const programs = path.join(dir, "programs");
  fs.mkdirSync(programs, { recursive: true });
  for (const [name, source] of Object.entries({ ...buildPrograms(params), ...(opts.secondStage ? buildSecondStage(params) : {}) })) {
    const file = path.join(programs, name);
    fs.writeFileSync(file, source, { mode: 0o755 });
    fs.chmodSync(file, 0o755);
  }
  fs.writeFileSync(path.join(dir, "raw.dump"), rawDump(params, seed + 1, 14));
  const goal: Goal = {
    id: `compliance-${params.theme}-${seed}`,
    intent: `Produce the ${params.programs.reporter} compliance report from a raw device dump`,
    have: { samples: [{ path: "raw.dump" }], description: "A raw device dump" },
    want: { program: params.programs.reporter, description: `The compliance report ${params.programs.reporter} prints` },
  };
  return { params, dir, programs, goal, base: dir };
}

