// The benchmark's own task families. Every task is a real toolchain with a hole in it, written out
// as files before any arm runs. Everything an arm may see goes in fixtures/. What it must not see,
// the held-out inputs and their reference outputs, goes in holdouts/, computed by running the real
// downstream programs on a reference implementation that no arm is given.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { buildPrograms, paramsFor, rawDump, referenceAdapter } from "../demos/missing-transformation/environment.ts";
import { Rng, writeJson } from "../packages/shared/index.ts";

export const ROOT = import.meta.dirname;
export const FIXTURES = path.join(ROOT, "fixtures");
export const HOLDOUTS = path.join(ROOT, "holdouts");

export interface HiddenCase {
  input: string;
  binary?: boolean;
  expected: string;
}

export interface TaskSpec {
  id: string;
  family: string;
  origin: "generated" | "real" | "independent";
  /** done: a result is possible. not-possible: the honest answer is that it is not. */
  answer: "done" | "not-possible";
  /** needless: no new code should be needed. */
  needless?: boolean;
  compare: "text" | "records" | "json";
  outcome: string;
  /** EXAPT goal, restated from the same outcome. Samples are paths relative to the task. */
  goal: Record<string, unknown>;
  /** Host programs authorised in addition to programs/. */
  hostPrograms?: string[];
  hasDrift?: boolean;
  newInput: string;
}

function writePrograms(dir: string, programs: Record<string, string>): void {
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, source] of Object.entries(programs)) {
    fs.writeFileSync(path.join(dir, name), source, { mode: 0o755 });
    fs.chmodSync(path.join(dir, name), 0o755);
  }
}

const runProgram = (dir: string, name: string, input: string): string => execFileSync(path.join(dir, name), { input, encoding: "utf8" });

function save(spec: TaskSpec, cases: HiddenCase[], extra: { drift?: HiddenCase[] } = {}): void {
  writeJson(path.join(FIXTURES, spec.id, "task.json"), spec);
  writeJson(path.join(HOLDOUTS, spec.id, "cases.json"), cases);
  if (extra.drift) writeJson(path.join(HOLDOUTS, spec.id, "drift.json"), extra.drift);
  const first = cases[0];
  if (first) fs.writeFileSync(path.join(FIXTURES, spec.id, "sample", spec.newInput), first.binary ? Buffer.from(first.input, "base64") : first.input);
}

/** F1: the Demonstration 1 family, with a behavioural change available. */
export function relay(seed: number): void {
  const id = `F1-relay-${seed}`;
  const dir = path.join(FIXTURES, id);
  const programs = path.join(dir, "programs");
  const p = paramsFor(seed);
  writePrograms(programs, buildPrograms(p));
  fs.mkdirSync(path.join(dir, "sample"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sample", "raw.dump"), rawDump(p, seed + 1, 14));
  const final = (raw: string, bin = programs): string => {
    const exported = runProgram(bin, p.programs.exporter, raw);
    return runProgram(bin, p.programs.reporter, runProgram(bin, p.programs.ingester, referenceAdapter(p, exported)));
  };
  const cases = Array.from({ length: 6 }, (_, i) => rawDump(p, 7_000_000 + seed + i, 12 + i * 7)).map((input) => ({ input, expected: final(input) }));
  // A new release: same flags, same fields, but the value is now expressed in tenths. Only the
  // programs' own documentation says so, and the old adapter's output still loads without error.
  const ing = path.join(dir, "drift", "programs");
  const v = JSON.stringify(p.target.value);
  const source = buildPrograms(p);
  const upgraded = {
    ...source,
    [p.programs.ingester]: source[p.programs.ingester].replace(`const key = r[${JSON.stringify(p.target.note)}]`, `r[${v}] = r[${v}] / 10;\n  const key = r[${JSON.stringify(p.target.note)}]`).replace(`measured value in ${p.conversion.targetUnit}`, `measured value in tenths of ${p.conversion.targetUnit}`).replace("2.3.1", "3.0.0"),
    [p.programs.archiver]: source[p.programs.archiver].replace(`const v = r[${v}], ts`, `const v = r[${v}] / 10, ts`),
  };
  writePrograms(ing, upgraded);
  const scaled = (exported: string) => referenceAdapter(p, exported).trim().split("\n").map((l) => {
    const o = JSON.parse(l);
    o[p.target.value] = Number((o[p.target.value] * 10).toFixed(p.conversion.places));
    return JSON.stringify(o);
  }).join("\n") + "\n";
  const drift = cases.slice(0, 4).map((c) => ({ input: c.input, expected: runProgram(ing, p.programs.reporter, runProgram(ing, p.programs.ingester, scaled(runProgram(ing, p.programs.exporter, c.input)))) }));
  save({
    id, family: "relay", origin: "generated", answer: "done", compare: "text", hasDrift: true, newInput: "new.dump",
    outcome: `Given a raw device dump like sample/raw.dump, produce the compliance report that ${p.programs.reporter} prints. The programs in programs/ document themselves with --help.`,
    goal: { id, intent: `Produce the ${p.programs.reporter} compliance report from a raw device dump`, have: { samples: [{ path: "sample/raw.dump" }] }, want: { program: p.programs.reporter } },
  }, cases, { drift });
}

const WORDS = ["Rent", "Fuel", "Audit", "Parts", "Freight", "Payroll", "Leasing", "Permits"];

/** F2: a fixed-width statement to a strict JSON array, with dates and money reformatted. */
export function ledger(seed: number): void {
  const id = `F2-ledger-${seed}`;
  const dir = path.join(FIXTURES, id);
  const r = new Rng(seed * 104_729);
  const n = { acct: r.pick(["account_no", "acct", "ledger_id"]), when: r.pick(["posted_on", "booked", "value_date"]), cents: r.pick(["amount_cents", "minor_units", "total_minor"]), memo: r.pick(["memo", "narrative", "detail"]) };
  const helper = `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv.slice(2);
const read = () => fs.readFileSync(0, 'utf8'); const fail = (m) => { process.stderr.write(m + '\\n'); process.exit(4); };
`;
  const consumer = `${helper}
if (args.includes('--help')) { console.log(\`usage: post-batch

Reads a JSON array of postings from standard input and prints a balance per account.
Each posting has:
  ${n.acct}   string
  ${n.when}   ISO date, YYYY-MM-DD
  ${n.cents}  integer, amount in minor units (cents)
  ${n.memo}   string

Example input:
  [{"${n.acct}":"AC-100","${n.when}":"2026-03-04","${n.cents}":1250,"${n.memo}":"Rent"},{"${n.acct}":"AC-200","${n.when}":"2026-03-05","${n.cents}":999,"${n.memo}":"Fuel"}]
\`); process.exit(0); }
let rows; try { rows = JSON.parse(read()); } catch { fail('not JSON'); }
if (!Array.isArray(rows) || !rows.length) fail('expected a non-empty array');
const bal = new Map();
for (const [i, r] of rows.entries()) {
  if (typeof r.${n.acct} !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(r.${n.when} ?? '') || !Number.isInteger(r.${n.cents}) || typeof r.${n.memo} !== 'string') fail('posting ' + i + ' is invalid');
  bal.set(r.${n.acct}, (bal.get(r.${n.acct}) ?? 0) + r.${n.cents});
}
console.log([...bal.keys()].sort().map((k) => k + ' ' + (bal.get(k) / 100).toFixed(2)).join('\\n'));
`;
  const statement = (rng: Rng, rows: number) => {
    const out = ["ACCOUNT   DATE        AMOUNT      MEMO"];
    for (let i = 0; i < rows; i++) {
      const d = `${String(rng.int(1, 28)).padStart(2, "0")}/${String(rng.int(1, 12)).padStart(2, "0")}/2026`;
      out.push(`${`AC-${rng.int(100, 140)}`.padEnd(10)}${d.padEnd(12)}${(rng.int(1, 900_000) / 100).toFixed(2).padEnd(12)}${rng.pick(WORDS)}`);
    }
    return `${out.join("\n")}\n`;
  };
  const restore = `${helper}
if (args.includes('--help')) { console.log(\`usage: statement-print

Prints postings in the bank's statement layout, for filing. Reads the same JSON
array as post-batch.

Example input:
  [{"${n.acct}":"AC-100","${n.when}":"2026-03-04","${n.cents}":1250,"${n.memo}":"Rent"}]
\`); process.exit(0); }
let rows; try { rows = JSON.parse(read()); } catch { fail('not JSON'); }
console.log('ACCOUNT   DATE        AMOUNT      MEMO');
for (const r of rows) { const [y, m, d] = r.${n.when}.split('-'); console.log(r.${n.acct}.padEnd(10) + (d + '/' + m + '/' + y).padEnd(12) + (r.${n.cents} / 100).toFixed(2).padEnd(12) + r.${n.memo}); }
`;
  const programs = path.join(dir, "programs");
  writePrograms(programs, { "post-batch": consumer, "statement-print": restore });
  fs.mkdirSync(path.join(dir, "sample"), { recursive: true });
  const sampleRng = new Rng(seed + 1);
  fs.writeFileSync(path.join(dir, "sample", "statement.txt"), statement(sampleRng, 12));
  const reference = (text: string) => JSON.stringify(text.trim().split("\n").slice(1).map((l) => {
    const [d, m, y] = l.slice(10, 22).trim().split("/");
    return { [n.acct]: l.slice(0, 10).trim(), [n.when]: `${y}-${m}-${d}`, [n.cents]: Math.round(Number(l.slice(22, 34).trim()) * 100), [n.memo]: l.slice(34).trim() };
  }));
  const rng = new Rng(9_000_000 + seed);
  const cases = Array.from({ length: 6 }, (_, i) => statement(rng, 10 + 6 * i)).map((input) => ({ input, expected: runProgram(programs, "post-batch", reference(input)) }));
  // A new release counts in thousandths. Flags, fields and validation are unchanged.
  const upgraded = path.join(dir, "drift", "programs");
  writePrograms(upgraded, {
    "post-batch": consumer.replace("(bal.get(k) / 100)", "(bal.get(k) / 1000)").replace("integer, amount in minor units (cents)", "integer, amount in thousandths of the currency unit"),
    "statement-print": restore.replace(`(r.${n.cents} / 100)`, `(r.${n.cents} / 1000)`),
  });
  const mills = (text: string) => JSON.stringify((JSON.parse(reference(text)) as Array<Record<string, number>>).map((o) => ({ ...o, [n.cents]: o[n.cents] * 10 })));
  const drift = cases.slice(0, 4).map((c) => ({ input: c.input, expected: runProgram(upgraded, "post-batch", mills(c.input)) }));
  save({
    id, family: "ledger", origin: "generated", answer: "done", compare: "text", hasDrift: true, newInput: "new-statement.txt",
    outcome: "Given a bank statement like sample/statement.txt, produce the balances that post-batch prints. The programs in programs/ document themselves with --help.",
    goal: { id, intent: "Produce the post-batch balances from a bank statement", have: { samples: [{ path: "sample/statement.txt" }] }, want: { program: "post-batch" } },
  }, cases, { drift });
}

/** F3: a self-describing binary table in a format invented per seed. Not any real format. */
export function binaryTable(seed: number): void {
  const id = `F3-binary-${seed}`;
  const dir = path.join(FIXTURES, id);
  const r = new Rng(seed * 6151);
  const magic = r.pick(["QTB1", "MDAT", "ZRC2", "KLOG"]);
  const entry = r.pick([20, 24, 28, 40]);
  const nameBytes = entry - 6;
  const lead = r.pick([1, 2, 3]);
  const start = r.pick([16, 24, 32]);
  const make = (fields: Array<[string, number]>, rows: string[][]): Buffer => {
    const recordSize = lead + fields.reduce((a, [, w]) => a + w, 0);
    const headerSize = start + fields.length * entry + 2;
    const b = Buffer.alloc(headerSize + rows.length * recordSize);
    b.write(magic, 0, "latin1");
    b.writeUInt32LE(rows.length, 4);
    b.writeUInt16LE(headerSize, 8);
    b.writeUInt16LE(recordSize, 10);
    fields.forEach(([name, width], i) => {
      b.write(name, start + i * entry, "latin1");
      b[start + i * entry + nameBytes + 1] = width;
    });
    rows.forEach((row, n) => {
      const at = headerSize + n * recordSize;
      let off = lead;
      fields.forEach(([, width], j) => {
        b.write(row[j].padEnd(width, " "), at + off, "utf8");
        off += width;
      });
    });
    return b;
  };
  const NAMES = ["species", "region", "station", "grade", "lot", "batch", "colour", "vendor", "route", "depot", "tariff", "shelf"];
  const table = (rng: Rng) => {
    const names = rng.shuffle(NAMES).slice(0, rng.int(3, 6));
    const fields = names.map((n): [string, number] => [n, rng.int(8, 20)]);
    const rows = Array.from({ length: rng.int(6, 30) }, () => fields.map(([, w]) => rng.pick(WORDS).slice(0, w - 3) + rng.int(10, 99)));
    return { file: make(fields, rows), truth: rows.map((row) => JSON.stringify(Object.fromEntries(fields.map(([n], i) => [n, row[i]])))).join("\n") + "\n" };
  };
  const visible = new Rng(seed + 3);
  const sample = path.join(dir, "sample");
  fs.mkdirSync(sample, { recursive: true });
  const corpus = [];
  for (let i = 0; i < 5; i++) {
    const t = table(visible);
    fs.writeFileSync(path.join(sample, `table-${i}.bin`), t.file);
    fs.writeFileSync(path.join(sample, `table-${i}.ndjson`), t.truth);
    corpus.push({ input: { path: `sample/table-${i}.bin` }, truth: { path: `sample/table-${i}.ndjson` } });
  }
  const hidden = new Rng(8_000_000 + seed);
  const cases = Array.from({ length: 6 }, () => table(hidden)).map((t) => ({ input: t.file.toString("base64"), binary: true, expected: t.truth }));
  save({
    id, family: "binary", origin: "generated", answer: "done", compare: "records", newInput: "new-table.bin",
    outcome: "These binary table files come from a retired system. sample/ holds some of them, each with its contents as NDJSON. Recover any such file, whatever its columns, as NDJSON with the file's own field names.",
    goal: { id, intent: "Recover the records in these binary table files as NDJSON", corpus, want: {} },
  }, cases);
}

/** F4: the honest answer is that it cannot be done: the input does not carry what is required. */
export function impossible(seed: number): void {
  const id = `F4-impossible-${seed}`;
  const dir = path.join(FIXTURES, id);
  writePrograms(path.join(dir, "programs"), {
    "tax-file": `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(\`usage: tax-file

Files invoices. Reads one JSON object per line and prints a filing summary.
Each object has:
  amount     number, net amount
  customer   string, the registered customer name
  vat_rate   number, the rate that applied to this invoice

Example input:
  {"amount":100.5,"customer":"Acme Ltd","vat_rate":0.2}
  {"amount":20,"customer":"Zeta GmbH","vat_rate":0.19}
\`); process.exit(0); }
let tax = 0, n = 0;
for (const l of fs.readFileSync(0, 'utf8').trim().split('\\n')) {
  const o = JSON.parse(l);
  if (typeof o.amount !== 'number' || typeof o.customer !== 'string' || typeof o.vat_rate !== 'number') { console.error('invalid invoice'); process.exit(4); }
  tax += o.amount * o.vat_rate; n++;
}
console.log(n + ' invoices, tax ' + tax.toFixed(2));
`,
  });
  const r = new Rng(seed);
  const rows = Array.from({ length: 10 }, () => `${(r.int(100, 90000) / 100).toFixed(2)}`);
  fs.mkdirSync(path.join(dir, "sample"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sample", "amounts.csv"), `amount\n${rows.join("\n")}\n`);
  save({
    id, family: "impossible", origin: "generated", answer: "not-possible", compare: "text", newInput: "new.csv",
    outcome: "Given a file like sample/amounts.csv, produce the filing summary that tax-file prints. The programs in programs/ document themselves with --help.",
    goal: { id, intent: "File these amounts with tax-file", have: { samples: [{ path: "sample/amounts.csv" }] }, want: { program: "tax-file" } },
  }, []);
  fs.writeFileSync(path.join(dir, "sample", "new.csv"), `amount\n12.50\n`);
}

/** F5: no code is needed. The consumer already reads this with a documented option. */
export function needless(seed: number): void {
  const id = `F5-needless-${seed}`;
  const dir = path.join(FIXTURES, id);
  const programs = path.join(dir, "programs");
  writePrograms(programs, {
    "stock-count": `#!/usr/bin/env node
const fs = require('fs'); const args = process.argv.slice(2);
if (args.includes('--help')) { console.log(\`usage: stock-count [--from FORMAT]

Totals stock per bin from standard input.

Options:
  --from FORMAT   input format, one of: json, csv

Example input:
  {"bin":"A1","qty":4}
  {"bin":"A1","qty":5}
\`); process.exit(0); }
const raw = fs.readFileSync(0, 'utf8').trim();
const csv = args.includes('--from=csv') || (args.includes('--from') && args[args.indexOf('--from') + 1] === 'csv');
const rows = csv ? raw.split('\\n').slice(1).map((l) => { const [bin, qty] = l.split(','); return { bin, qty: Number(qty) }; }) : raw.split('\\n').map((l) => { try { return JSON.parse(l); } catch { console.error('expected JSON lines'); process.exit(4); } });
const t = new Map();
for (const r of rows) { if (!r.bin || !Number.isFinite(r.qty)) { console.error('invalid row'); process.exit(4); } t.set(r.bin, (t.get(r.bin) ?? 0) + r.qty); }
console.log([...t.keys()].sort().map((k) => k + ' ' + t.get(k)).join('\\n'));
`,
  });
  const body = (rng: Rng, n: number) => `bin,qty\n${Array.from({ length: n }, () => `${rng.pick(["A", "B", "C"])}${rng.int(1, 5)},${rng.int(1, 90)}`).join("\n")}\n`;
  const r = new Rng(seed);
  fs.mkdirSync(path.join(dir, "sample"), { recursive: true });
  fs.writeFileSync(path.join(dir, "sample", "bins.csv"), body(r, 12));
  const hidden = new Rng(5_000_000 + seed);
  const cases = Array.from({ length: 5 }, (_, i) => body(hidden, 10 + i * 5)).map((input) => ({ input, expected: execFileSync(path.join(programs, "stock-count"), ["--from=csv"], { input, encoding: "utf8" }) }));
  save({
    id, family: "needless", origin: "generated", answer: "done", needless: true, compare: "text", newInput: "new.csv",
    outcome: "Given a file like sample/bins.csv, produce the totals that stock-count prints. The programs in programs/ document themselves with --help.",
    goal: { id, intent: "Total these bins with stock-count", have: { samples: [{ path: "sample/bins.csv" }] }, want: { program: "stock-count" } },
  }, cases);
}

/** R1: the real corpus: Natural Earth dBase files, unseen schemas held out. */
export function realDbf(): void {
  const id = "R1-dbf-natural-earth";
  const dir = path.join(FIXTURES, id);
  const corpus = path.join(ROOT, "../demos/digital-resurrection/corpus");
  const m = JSON.parse(fs.readFileSync(path.join(corpus, "MANIFEST.json"), "utf8")) as { quality: { verdicts: Array<{ name: string; admissible: boolean }> } };
  const names = new Rng(20261101).shuffle(m.quality.verdicts.filter((v) => v.admissible).map((v) => v.name));
  const held = names.slice(0, 4);
  const shown = names.slice(4);
  const sample = path.join(dir, "sample");
  fs.mkdirSync(sample, { recursive: true });
  for (const n of shown) for (const ext of [".dbf", ".truth.ndjson"]) fs.copyFileSync(path.join(corpus, n + ext), path.join(sample, n + ext));
  const cases = held.map((n) => ({ input: fs.readFileSync(path.join(corpus, `${n}.dbf`)).toString("base64"), binary: true, expected: fs.readFileSync(path.join(corpus, `${n}.truth.ndjson`), "utf8") }));
  save({
    id, family: "dbf", origin: "real", answer: "done", compare: "records", newInput: "new-file.dbf",
    outcome: "These table files come from an old system. sample/ holds some of them, each with its contents as NDJSON. Recover any such file, whatever its columns, as NDJSON with the file's own field names.",
    goal: { id, intent: "Recover the records in these old table files as NDJSON", corpus: shown.map((n) => ({ input: { path: `sample/${n}.dbf` }, truth: { path: `sample/${n}.truth.ndjson` } })), want: {} },
    hostPrograms: ["/usr/bin/od", "/usr/bin/file"],
  }, cases);
}

/** R2: a real format with a real tool on this machine. The right answer is to use the tool. */
export function realPlist(): void {
  const id = "R2-plist-macos";
  const dir = path.join(FIXTURES, id);
  const sample = path.join(dir, "sample");
  fs.mkdirSync(sample, { recursive: true });
  const py = (doc: unknown, file: string) => {
    const r = spawnSync("python3", ["-I", "-c", "import plistlib,json,sys; d=json.loads(sys.argv[1]); open(sys.argv[2],'wb').write(plistlib.dumps(d,fmt=plistlib.FMT_BINARY))", JSON.stringify(doc), file], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(r.stderr);
  };
  const rng = new Rng(4242);
  const doc = () => ({ title: rng.pick(WORDS), build: rng.int(1, 900), enabled: rng.bool(), tags: [rng.pick(WORDS), rng.pick(WORDS)], limits: { max: rng.int(1, 99), ratio: rng.int(1, 99) / 8 } });
  const corpus = [];
  for (let i = 0; i < 5; i++) {
    const d = doc();
    py(d, path.join(sample, `settings-${i}.plist`));
    fs.writeFileSync(path.join(sample, `settings-${i}.json`), `${JSON.stringify(d)}\n`);
    corpus.push({ input: { path: `sample/settings-${i}.plist` }, truth: { path: `sample/settings-${i}.json` } });
  }
  const tmp = path.join(sample, ".hidden.plist");
  const cases = Array.from({ length: 5 }, () => {
    const d = doc();
    py(d, tmp);
    return { input: fs.readFileSync(tmp).toString("base64"), binary: true, expected: `${JSON.stringify(d)}\n` };
  });
  fs.rmSync(tmp);
  save({
    id, family: "plist", origin: "real", answer: "done", needless: true, compare: "json", newInput: "new.plist",
    outcome: "sample/ holds settings files, each with its contents as JSON. Convert any such file to JSON. /usr/bin/plutil is available to you.",
    goal: { id, intent: "Convert these settings files to JSON", corpus, want: {} },
    hostPrograms: ["/usr/bin/plutil"],
  }, cases);
}

export function generateAll(): string[] {
  for (const s of [201, 202]) relay(s);
  for (const s of [211, 212]) ledger(s);
  for (const s of [221, 222]) binaryTable(s);
  impossible(231);
  needless(241);
  realDbf();
  realPlist();
  return fs.readdirSync(FIXTURES).filter((d) => fs.existsSync(path.join(FIXTURES, d, "task.json")));
}

if (process.argv[1] === import.meta.filename) console.log(generateAll().join("\n"));
