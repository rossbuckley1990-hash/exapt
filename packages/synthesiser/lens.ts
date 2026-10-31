// Deterministic synthesis of record transformations, with no model.
//
// Given input/output examples, this infers the syntax on each side, aligns records, and for each
// target field searches a small expression language bottom-up for the smallest expression that
// explains every example row, keeping one expression per distinct behaviour (observational
// equivalence). There is no table of known formats-to-formats and no per-task knowledge: the
// programs it can reach are exactly the expressions of this language over the example data, and a
// task outside the language fails honestly and falls to a model. The emitted JavaScript is
// untrusted like any other candidate and runs only behind the execution boundary.
import { cellText, kindOf, parseRecords, sniffSyntax, type Rec, type Scalar, type Syntax } from "../capability-universe/repr.ts";

export type Expr =
  | { op: "field"; name: string }
  | { op: "const"; value: Scalar }
  | { op: "num"; e: Expr }
  | { op: "linear"; a: Ratio; b: Ratio; e: Expr }
  | { op: "upper" | "lower" | "trim"; e: Expr }
  | { op: "epoch"; e: Expr; scale: number }
  | { op: "iso"; e: Expr; scale: number; dateOnly: boolean }
  | { op: "datefmt"; e: Expr; pattern: string }
  | { op: "part"; e: Expr; sep: string; index: number }
  | { op: "replace"; e: Expr; from: string; to: string }
  | { op: "concat"; a: Expr; sep: string; b: Expr }
  | { op: "boolean"; e: Expr; truthy: string[] }
  | { op: "map"; e: Expr; table: Record<string, Scalar> };

/** An exact rational, so 5/9 stays 5/9 rather than becoming a rounded float. */
export interface Ratio {
  n: number;
  d: number;
}

export interface FieldProgram {
  name: string;
  expr: Expr;
  size: number;
  /** How the value is written: fixed decimals, or the number itself. */
  format: { kind: "text" } | { kind: "number"; places: number; fixed: boolean; integer: boolean } | { kind: "boolean" };
}

export interface LensProgram {
  source: Syntax;
  target: Syntax;
  sourceFields: string[];
  fields: FieldProgram[];
}

export type LensResult = { ok: true; programs: LensProgram[]; explored: number } | { ok: false; reason: string; explored: number };

const size = (e: Expr): number => {
  switch (e.op) {
    case "field":
    case "const":
      return 1;
    case "concat":
      return size(e.a) + size(e.b) + 1;
    case "map":
      return size(e.e) + 3 + Object.keys(e.table).length;
    case "linear":
      return size(e.e) + 1 + (e.b.n === 0 ? 0 : 1) + (e.a.n === e.a.d ? 0 : 1);
    default:
      return size(e.e) + 1;
  }
};

const ratioValue = (r: Ratio): number => r.n / r.d;

function evaluate(e: Expr, r: Rec): Scalar {
  switch (e.op) {
    case "field":
      return r[e.name] ?? null;
    case "const":
      return e.value;
    case "num": {
      const n = Number(cellText(evaluate(e.e, r)).trim());
      return Number.isFinite(n) && cellText(evaluate(e.e, r)).trim() !== "" ? n : null;
    }
    case "linear": {
      const v = Number(evaluate(e.e, r));
      return Number.isFinite(v) ? (v * e.a.n) / e.a.d + e.b.n / e.b.d : null;
    }
    case "upper":
      return cellText(evaluate(e.e, r)).toUpperCase();
    case "lower":
      return cellText(evaluate(e.e, r)).toLowerCase();
    case "trim":
      return cellText(evaluate(e.e, r)).trim();
    case "epoch": {
      const t = Date.parse(cellText(evaluate(e.e, r)));
      return Number.isNaN(t) ? null : t / e.scale;
    }
    case "iso": {
      const v = Number(evaluate(e.e, r));
      if (!Number.isFinite(v)) return null;
      const s = new Date(v * e.scale).toISOString();
      return e.dateOnly ? s.slice(0, 10) : s.replace(".000Z", "Z");
    }
    case "datefmt": {
      const t = Date.parse(cellText(evaluate(e.e, r)));
      return Number.isNaN(t) ? null : formatDate(new Date(t), e.pattern);
    }
    case "part":
      return cellText(evaluate(e.e, r)).split(e.sep)[e.index] ?? null;
    case "replace":
      return cellText(evaluate(e.e, r)).split(e.from).join(e.to);
    case "concat":
      return `${cellText(evaluate(e.a, r))}${e.sep}${cellText(evaluate(e.b, r))}`;
    case "boolean":
      return e.truthy.includes(cellText(evaluate(e.e, r)).trim().toLowerCase());
    case "map":
      return e.table[cellText(evaluate(e.e, r))] ?? null;
  }
}

const DATE_PATTERNS = ["YYYYMMDD", "YYYY/MM/DD", "DD/MM/YYYY", "MM/DD/YYYY", "DD.MM.YYYY", "YYYY-MM-DD", "YYYY-MM-DD HH:mm:ss"];

function formatDate(d: Date, pattern: string): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return pattern.replace("YYYY", String(d.getUTCFullYear())).replace("MM", p(d.getUTCMonth() + 1)).replace("DD", p(d.getUTCDate())).replace("HH", p(d.getUTCHours())).replace("mm", p(d.getUTCMinutes())).replace("ss", p(d.getUTCSeconds()));
}

/** The simplest rational within tolerance of x, by continued fractions. */
function nearestRatio(x: number, tolerance: number): Ratio {
  if (Number.isInteger(x)) return { n: x, d: 1 };
  const sign = x < 0 ? -1 : 1;
  let [h0, h1, k0, k1] = [0, 1, 1, 0];
  let v = Math.abs(x);
  for (let i = 0; i < 32; i++) {
    const a = Math.floor(v);
    [h0, h1] = [h1, a * h1 + h0];
    [k0, k1] = [k1, a * k1 + k0];
    if (Math.abs(h1 / k1 - Math.abs(x)) <= tolerance || k1 > 100000) break;
    if (v === a) break;
    v = 1 / (v - a);
  }
  return { n: sign * h1, d: k1 };
}

interface TargetColumn {
  values: Scalar[];
  numeric: boolean;
  places: number;
  fixed: boolean;
  jsonNumber: boolean;
  allIntegers: boolean;
  boolean: boolean;
}

function describeColumn(values: Scalar[]): TargetColumn {
  const text = values.map(cellText);
  const numeric = values.every((v) => typeof v === "number" || (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())));
  const places = Math.max(0, ...text.map((t) => t.split(".")[1]?.length ?? 0));
  const fixed = numeric && text.every((t) => (t.split(".")[1]?.length ?? 0) === places);
  return { values, numeric, places, fixed, jsonNumber: values.every((v) => typeof v === "number"), allIntegers: text.every((t) => /^-?\d+$/.test(t)), boolean: values.every((v) => typeof v === "boolean") };
}

function formatFor(c: TargetColumn): FieldProgram["format"] {
  if (c.boolean) return { kind: "boolean" };
  if (c.numeric) return { kind: "number", places: c.places, fixed: !c.jsonNumber && c.fixed, integer: c.allIntegers };
  return { kind: "text" };
}

/** Does this value, once written the column's way, equal the example? */
function agrees(v: Scalar, target: Scalar, c: TargetColumn): boolean {
  if (v === null || v === undefined) return target === null;
  if (c.boolean) return v === target;
  if (c.numeric) {
    const n = typeof v === "number" ? v : cellText(v).trim() === "" ? NaN : Number(v);
    if (!Number.isFinite(n)) return false;
    const rounded = Number(n.toFixed(c.places));
    return Math.abs(rounded - Number(target)) < 1e-9 * Math.max(1, Math.abs(rounded));
  }
  return cellText(v) === cellText(target);
}

function textSeparators(values: string[]): string[] {
  const seen = new Set<string>();
  for (const v of values) for (const m of v.matchAll(/[^A-Za-z0-9]/g)) seen.add(m[0]);
  return [...seen].slice(0, 6);
}

/** Expressions over the source fields, smallest first, one per distinct behaviour on the rows. */
function* bank(rows: Rec[], names: string[], counter: { n: number }): Generator<Expr> {
  const seen = new Set<string>();
  const novel = (e: Expr): boolean => {
    counter.n++;
    const key = JSON.stringify(rows.map((r) => evaluate(e, r)));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
  const level0: Expr[] = names.map((name) => ({ op: "field", name }));
  for (const e of level0) if (novel(e)) yield e;
  const level1: Expr[] = [];
  for (const e of level0) {
    const values = rows.map((r) => cellText(evaluate(e, r)));
    const candidates: Expr[] = [{ op: "trim", e }, { op: "upper", e }, { op: "lower", e }];
    if (values.every((v) => kindOf(v) === "int" || kindOf(v) === "decimal")) {
      candidates.push({ op: "num", e });
      if (values.every((v) => Math.abs(Number(v)) > 1e8)) for (const scale of [1000, 1]) for (const dateOnly of [false, true]) candidates.push({ op: "iso", e, scale, dateOnly });
    }
    if (values.every((v) => !Number.isNaN(Date.parse(v)) && /\d{4}/.test(v))) {
      candidates.push({ op: "epoch", e, scale: 1000 }, { op: "epoch", e, scale: 1 });
      for (const pattern of DATE_PATTERNS) candidates.push({ op: "datefmt", e, pattern });
    }
    for (const sep of textSeparators(values)) {
      const widest = Math.max(...values.map((v) => v.split(sep).length));
      for (let index = 0; index < Math.min(widest, 5); index++) candidates.push({ op: "part", e, sep, index });
      for (const to of ["", " ", "_", "-", "."]) if (to !== sep) candidates.push({ op: "replace", e, from: sep, to });
    }
    for (const c of candidates) if (novel(c)) {
      level1.push(c);
      yield c;
    }
  }
  for (const e of level1) for (const op of ["upper", "lower", "trim"] as const) {
    const c: Expr = { op, e };
    if (novel(c)) yield c;
  }
}

/** Fit target = a * source + b over the rows, then read the coefficients as simple rationals. */
function linearFits(rows: Rec[], names: string[], c: TargetColumn): Expr[] {
  const out: Expr[] = [];
  const ys = c.values.map(Number);
  const resolution = 0.5 * 10 ** -c.places;
  for (const name of names) {
    const e: Expr = { op: "num", e: { op: "field", name } };
    const xs = rows.map((r) => evaluate(e, r));
    if (xs.some((x) => x === null)) continue;
    const nums = xs.map(Number);
    const distinct = new Set(nums);
    if (distinct.size === 1) {
      // One observed x cannot separate scale from offset. Prefer a pure scale, the simpler claim.
      if (nums[0] !== 0) out.push({ op: "linear", a: nearestRatio(ys[0] / nums[0], Math.abs(resolution / nums[0])), b: { n: 0, d: 1 }, e });
      out.push({ op: "linear", a: { n: 1, d: 1 }, b: nearestRatio(ys[0] - nums[0], resolution), e });
      continue;
    }
    const n = nums.length;
    const [sx, sy] = [nums.reduce((a, b) => a + b, 0), ys.reduce((a, b) => a + b, 0)];
    const sxx = nums.reduce((a, x) => a + x * x, 0);
    const sxy = nums.reduce((a, x, i) => a + x * ys[i], 0);
    const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const spread = Math.max(...nums) - Math.min(...nums);
    const a = nearestRatio(slope, (2 * resolution) / spread);
    const offset = (sy - (slope * sx)) / n;
    for (const aa of [a, nearestRatio(slope, 1e-7)]) {
      const b0 = (sy - (ratioValue(aa) * sx)) / n;
      for (const b of [nearestRatio(b0, resolution / 2), nearestRatio(offset, 1e-6), { n: 0, d: 1 }]) out.push({ op: "linear", a: aa, b, e });
    }
  }
  return out;
}

const CONSTANT_GUARD = 2;

function searchField(rows: Rec[], names: string[], c: TargetColumn, counter: { n: number }): Expr[] {
  const found: Expr[] = [];
  const consider = (e: Expr) => {
    counter.n++;
    if (rows.every((r, i) => agrees(evaluate(e, r), c.values[i], c))) found.push(e);
  };
  const concatSources: Expr[] = [];
  for (const e of bank(rows, names, counter)) {
    consider(e);
    if (e.op === "field" || e.op === "part") concatSources.push(e);
  }
  if (c.numeric && !c.boolean) for (const e of linearFits(rows, names, c)) consider(e);
  if (!c.numeric && !c.boolean) {
    const texts = c.values.map(cellText);
    for (const sep of ["", ...textSeparators(texts)]) for (const a of concatSources) for (const b of concatSources) consider({ op: "concat", a, sep, b });
  }
  if (c.boolean) {
    for (const name of names) {
      const truthy = [...new Set(rows.filter((_, i) => c.values[i] === true).map((r) => cellText(r[name]).trim().toLowerCase()))];
      if (truthy.length && truthy.length <= 3) consider({ op: "boolean", e: { op: "field", name }, truthy });
    }
  }
  // A constant explains a column only when it repeats; one row proves nothing about constancy.
  if (new Set(c.values.map(cellText)).size === 1 && (c.values.length >= CONSTANT_GUARD || !found.length)) found.push({ op: "const", value: c.values[0] });
  // A lookup table is the weakest explanation and goes last: unseen keys will throw.
  const distinct = new Set(c.values.map(cellText)).size;
  if (!found.length && distinct <= 12) {
    for (const name of names) {
      const table: Record<string, Scalar> = {};
      let consistent = true;
      rows.forEach((r, i) => {
        const key = cellText(r[name]);
        if (key in table && cellText(table[key]) !== cellText(c.values[i])) consistent = false;
        table[key] = c.values[i];
      });
      if (consistent && Object.keys(table).length <= 12) found.push({ op: "map", e: { op: "field", name }, table });
    }
  }
  return [...found].sort((a, b) => size(a) - size(b));
}

/** Synthesise from examples. `pairs` are complete input and output values. */
export function synthesiseLens(pairs: Array<{ input: string; output: string }>, opts: { alternatives?: number } = {}): LensResult {
  const counter = { n: 0 };
  if (!pairs.length) return { ok: false, reason: "no input/output examples are available", explored: 0 };
  const source = sniffSyntax(pairs[0].input);
  const target = sniffSyntax(pairs[0].output);
  if (["text", "binary"].includes(source.format)) return { ok: false, reason: `the source (${source.format}) has no record structure this language can read`, explored: 0 };
  if (["text", "binary"].includes(target.format)) return { ok: false, reason: `the target (${target.format}) has no record structure this language can write`, explored: 0 };
  const rows: Rec[] = [];
  const targets: Rec[] = [];
  for (const p of pairs) {
    const [s, t] = [parseRecords(p.input, source), parseRecords(p.output, target)];
    if (s.length !== t.length) return { ok: false, reason: `an example maps ${s.length} records to ${t.length}: filtering and aggregation are outside this language`, explored: counter.n };
    rows.push(...s);
    targets.push(...t);
  }
  if (!rows.length) return { ok: false, reason: "the examples contain no records", explored: 0 };
  const names = Object.keys(rows[0]);
  const targetNames = Object.keys(targets[0]);
  const fields: FieldProgram[][] = [];
  for (const name of targetNames) {
    const column = describeColumn(targets.map((t) => t[name] ?? null));
    const found = searchField(rows, names, column, counter);
    if (!found.length) return { ok: false, reason: `no expression in the language explains target field "${name}"`, explored: counter.n };
    fields.push(found.slice(0, 4).map((expr) => ({ name, expr, size: size(expr), format: formatFor(column) })));
  }
  const programs: LensProgram[] = [{ source, target, sourceFields: names, fields: fields.map((f) => f[0]) }];
  // Alternatives vary the most ambiguous fields one at a time.
  const limit = opts.alternatives ?? 3;
  for (const [i, options] of fields.entries()) {
    for (const alt of options.slice(1)) {
      if (programs.length >= limit) break;
      programs.push({ source, target, sourceFields: names, fields: fields.map((f, j) => (j === i ? alt : f[0])) });
    }
  }
  return { ok: true, programs, explored: counter.n };
}

// ---------------------------------------------------------------- emission

const lit = (v: unknown): string => JSON.stringify(v);

function emitExpr(e: Expr): string {
  switch (e.op) {
    case "field":
      return `field(r, ${lit(e.name)})`;
    case "const":
      return lit(e.value);
    case "num":
      return `num(${emitExpr(e.e)})`;
    case "linear": {
      const x = emitExpr(e.e);
      const scaled = e.a.n === e.a.d ? x : `${x} * ${e.a.n}${e.a.d === 1 ? "" : ` / ${e.a.d}`}`;
      return e.b.n === 0 ? `(${scaled})` : `(${scaled} + ${e.b.n}${e.b.d === 1 ? "" : ` / ${e.b.d}`})`;
    }
    case "upper":
      return `text(${emitExpr(e.e)}).toUpperCase()`;
    case "lower":
      return `text(${emitExpr(e.e)}).toLowerCase()`;
    case "trim":
      return `text(${emitExpr(e.e)}).trim()`;
    case "epoch":
      return `(instant(${emitExpr(e.e)}) / ${e.scale})`;
    case "iso": {
      const s = `new Date(num(${emitExpr(e.e)}) * ${e.scale}).toISOString()`;
      return e.dateOnly ? `${s}.slice(0, 10)` : `${s}.replace(".000Z", "Z")`;
    }
    case "datefmt":
      return `dateText(${emitExpr(e.e)}, ${lit(e.pattern)})`;
    case "part":
      return `partOf(${emitExpr(e.e)}, ${lit(e.sep)}, ${e.index})`;
    case "replace":
      return `text(${emitExpr(e.e)}).split(${lit(e.from)}).join(${lit(e.to)})`;
    case "concat":
      return `(text(${emitExpr(e.a)}) + ${lit(e.sep)} + text(${emitExpr(e.b)}))`;
    case "boolean":
      return `${lit(e.truthy)}.includes(text(${emitExpr(e.e)}).trim().toLowerCase())`;
    case "map":
      return `lookup(${lit(e.table)}, ${emitExpr(e.e)})`;
  }
}

function emitValue(f: FieldProgram): string {
  const v = emitExpr(f.expr);
  if (f.format.kind === "number") {
    const { places, fixed } = f.format;
    if (f.expr.op === "const") return v;
    return fixed ? `num(${v}).toFixed(${places})` : `Number(num(${v}).toFixed(${places}))`;
  }
  if (f.format.kind === "boolean") return v;
  return f.expr.op === "const" ? v : `text(${v})`;
}

const PARSERS: Record<string, string> = {
  common: `const lines = (t) => t.replace(/\\r\\n/g, "\\n").split("\\n").filter((l) => l.trim() !== "");
const text = (v) => (v === null || v === undefined ? "" : String(v));
const num = (v) => {
  const s = text(v).trim();
  const n = Number(s);
  if (s === "" || !Number.isFinite(n)) throw new Error("not a number: " + s);
  return n;
};
const instant = (v) => {
  const t = Date.parse(text(v));
  if (Number.isNaN(t)) throw new Error("not a date: " + text(v));
  return t;
};
const field = (r, name) => {
  if (!(name in r)) throw new Error("missing field: " + name);
  return r[name];
};`,
  splitter: `const cells = (line, d) => {
  const out = [];
  let cur = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur === "") quoted = true;
    else if (c === d) { out.push(cur); cur = ""; }
    else cur += c;
  }
  out.push(cur);
  return out;
};`,
};

function emitParser(s: Syntax, names: string[]): string {
  switch (s.format) {
    case "delimited": {
      const head = s.header
        ? `const header = cells(ls[0], ${lit(s.delimiter)}).map((c) => c.trim());
  for (const n of ${lit(names)}) if (!header.includes(n)) throw new Error("missing column: " + n);
  const body = ls.slice(1);`
        : `const header = ${lit(names)};
  const body = ls;`;
      return `${PARSERS.splitter}
const parse = (input) => {
  const ls = lines(input);
  if (!ls.length) throw new Error("empty input");
  ${head}
  return body.map((l, i) => {
    const row = cells(l, ${lit(s.delimiter)});
    if (row.length !== header.length) throw new Error("row " + (i + 1) + " has " + row.length + " cells, expected " + header.length);
    return Object.fromEntries(header.map((h, j) => [h, row[j]]));
  });
};`;
    }
    case "ndjson":
      return `const parse = (input) => lines(input).map((l) => JSON.parse(l));`;
    case "json-array":
      return `const parse = (input) => JSON.parse(input);`;
    case "json-document":
      return `const parse = (input) => JSON.parse(input)[${lit(s.recordsKey)}];`;
    case "kv-blocks":
      return `const parse = (input) => {
  const out = [];
  let cur = {};
  const flush = () => { if (Object.keys(cur).length) out.push(cur); cur = {}; };
  for (const raw of input.replace(/\\r\\n/g, "\\n").split("\\n")) {
    if (!raw.trim()) { flush(); continue; }
    const at = raw.indexOf(${lit(s.separator)});
    if (at < 0) throw new Error("not a key/value line: " + raw);
    const key = raw.slice(0, at).trim();
    if (key in cur) flush();
    cur[key] = raw.slice(at + 1).trim();
  }
  flush();
  return out;
};`;
    case "logfmt":
      return `const parse = (input) => lines(input).map((l) => {
  const rec = {};
  for (const m of l.matchAll(/([A-Za-z_][\\w.-]*)=("(?:[^"\\\\]|\\\\.)*"|\\S*)/g)) rec[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\\\(.)/g, "$1") : m[2];
  return rec;
});`;
    case "fixed-width":
      return `const parse = (input) => {
  const columns = ${lit(s.columns)};
  const ls = lines(input);
  return ${s.header ? "ls.slice(1)" : "ls"}.map((l) => Object.fromEntries(columns.map((c) => [c.name, l.slice(c.start, c.end).trim()])));
};`;
    default:
      throw new Error(`cannot parse ${s.format}`);
  }
}

function emitRender(s: Syntax, names: string[]): string {
  switch (s.format) {
    case "ndjson":
      return `const render = (rows) => rows.map((r) => JSON.stringify(r)).join("\\n") + (rows.length ? "\\n" : "");`;
    case "json-array":
      return `const render = (rows) => JSON.stringify(rows) + "\\n";`;
    case "json-document":
      return `const render = (rows) => JSON.stringify({ [${lit(s.recordsKey)}]: rows }) + "\\n";`;
    case "delimited":
      return `const quote = (v) => { const t = text(v); return t.includes(${lit(s.delimiter)}) || t.includes('"') ? '"' + t.replace(/"/g, '""') + '"' : t; };
const render = (rows) => [${s.header ? `${lit(names)}.join(${lit(s.delimiter)}), ` : ""}...rows.map((r) => ${lit(names)}.map((n) => quote(r[n])).join(${lit(s.delimiter)}))].join("\\n") + "\\n";`;
    case "kv-blocks":
      return `const render = (rows) => rows.map((r) => ${lit(names)}.map((n) => n + ${lit(s.separator)} + " " + text(r[n])).join("\\n")).join("\\n\\n") + "\\n";`;
    case "logfmt":
      return `const render = (rows) => rows.map((r) => ${lit(names)}.map((n) => { const t = text(r[n]); return n + "=" + (/[\\s"]/.test(t) || t === "" ? JSON.stringify(t) : t); }).join(" ")).join("\\n") + "\\n";`;
    case "fixed-width":
      return `const columns = ${lit(s.columns)};
const render = (rows) => [${s.header ? `columns.map((c, i) => i === columns.length - 1 ? c.name : c.name.padEnd(c.end - c.start)).join("").trimEnd(), ` : ""}...rows.map((r) => columns.map((c, i) => i === columns.length - 1 ? text(r[c.name]) : text(r[c.name]).padEnd(c.end - c.start)).join("").trimEnd())].join("\\n") + "\\n";`;
    default:
      throw new Error(`cannot render ${s.format}`);
  }
}

/** Only the helpers a program uses, so its size means something when versions are compared. */
function emitHelpers(fields: FieldProgram[]): string {
  const used = JSON.stringify(fields.map((f) => f.expr));
  const parts: string[] = [];
  if (used.includes('"part"')) parts.push(`const partOf = (v, sep, i) => {
  const p = text(v).split(sep);
  if (i >= p.length) throw new Error("no part " + i + " in " + text(v));
  return p[i];
};`);
  if (used.includes('"map"')) parts.push(`const lookup = (table, key) => {
  if (!(text(key) in table)) throw new Error("unknown value: " + text(key));
  return table[text(key)];
};`);
  if (used.includes('"datefmt"')) parts.push(`const dateText = (v, pattern) => {
  const d = new Date(instant(v));
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return pattern.replace("YYYY", String(d.getUTCFullYear())).replace("MM", p(d.getUTCMonth() + 1)).replace("DD", p(d.getUTCDate())).replace("HH", p(d.getUTCHours())).replace("mm", p(d.getUTCMinutes())).replace("ss", p(d.getUTCSeconds()));
};`);
  return parts.join("\n");
}

/** A self-contained ES module for the sandbox. */
export function emitLens(p: LensProgram): string {
  const names = p.fields.map((f) => f.name);
  return `// Synthesised by EXAPT's enumerative lens search.
${PARSERS.common}
${emitHelpers(p.fields)}
${emitParser(p.source, p.sourceFields)}
${emitRender(p.target, names)}
export function transform(input) {
  const rows = parse(typeof input === "string" ? input : input.toString("utf8"));
  return render(rows.map((r) => ({
${p.fields.map((f) => `    ${lit(f.name)}: ${emitValue(f)},`).join("\n")}
  })));
}
`;
}

export function describeLens(p: LensProgram): string[] {
  return p.fields.map((f) => `${f.name} = ${emitExpr(f.expr).replace(/field\(r, "([^"]+)"\)/g, "$1")}`);
}
