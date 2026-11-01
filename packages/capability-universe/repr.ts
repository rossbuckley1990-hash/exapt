// Representations: what a byte stream actually is, independently of what a contract calls it.
//
// RightClick X types a value semantically ("text", "json", "url"). That is enough to chain APIs
// whose schemas name their fields, but every delimited file, log and report is "text", so a type
// match says nothing about whether one program can read what another writes. A Repr is the
// finer, observed description EXAPT plans with: the syntax of a value and the shape of its fields,
// inferred from real bytes. Two values of type "text" with different Reprs are different things.

export type Scalar = string | number | boolean | null;
export type Rec = Record<string, Scalar>;
export type FieldKind = "int" | "decimal" | "bool" | "date" | "datetime" | "string" | "empty";

export interface Field {
  name: string;
  kind: FieldKind;
  /** Largest number of fractional digits seen, for decimals. */
  decimals?: number;
  min?: number;
  max?: number;
  cardinality: number;
  samples: string[];
}

export type Syntax =
  | { format: "delimited"; delimiter: string; header: boolean }
  | { format: "ndjson" }
  | { format: "json-array" }
  | { format: "json-document"; recordsKey: string }
  | { format: "kv-blocks"; separator: string }
  | { format: "logfmt" }
  | { format: "fixed-width"; columns: Array<{ name: string; start: number; end: number }>; header: boolean }
  | { format: "text" }
  | { format: "binary"; magic: string; size: number };

export interface Repr {
  syntax: Syntax;
  fields: Field[];
  records: number;
}

const DELIMITERS = [",", ";", "\t", "|"];

export const isRecordRepr = (r: Repr): boolean => !["text", "binary"].includes(r.syntax.format);

/** A compact stable name, used as the graph's vertex label for this representation. */
export function reprLabel(r: Repr): string {
  const s = r.syntax;
  const names = r.fields.map((f) => f.name).join(",");
  switch (s.format) {
    case "delimited":
      return `delimited(${JSON.stringify(s.delimiter).slice(1, -1)}${s.header ? "" : ",no-header"}){${names}}`;
    case "kv-blocks":
      return `kv-blocks(${s.separator}){${names}}`;
    case "json-document":
      return `json-document(.${s.recordsKey}){${names}}`;
    case "fixed-width":
      return `fixed-width{${names}}`;
    case "binary":
      return `binary(magic:${s.magic})`;
    case "text":
      return "text";
    default:
      return `${s.format}{${names}}`;
  }
}

// ---------------------------------------------------------------- sniffing

function isBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, 8192);
  if (head.includes(0)) return true;
  const text = head.toString("utf8");
  const bad = (text.match(/�/g) ?? []).length;
  if (bad > 0 && bad / Math.max(text.length, 1) > 0.01) return true;
  let control = 0;
  for (const b of head) if (b < 9 || (b > 13 && b < 32)) control++;
  return control / Math.max(head.length, 1) > 0.05;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function flatRecord(v: Record<string, unknown>): Rec {
  const out: Rec = {};
  for (const [k, x] of Object.entries(v)) {
    if (x === null || ["string", "number", "boolean"].includes(typeof x)) out[k] = x as Scalar;
    else out[k] = JSON.stringify(x);
  }
  return out;
}

function splitDelimited(line: string, d: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"' && cur === "") quoted = true;
    else if (c === d) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

const lines = (text: string): string[] => text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n").filter((l) => l.trim() !== "");

function looksLikeHeader(first: string[], rest: string[][]): boolean {
  if (!first.every((c) => /^[A-Za-z_][\w .%/()-]*$/.test(c.trim()))) return false;
  if (new Set(first).size !== first.length) return false;
  if (!rest.length) return true;
  // A header's cells differ in kind from the values beneath at least one column, or they are
  // identifier-shaped words that never recur below.
  return first.some((c, i) => kindOf(c.trim()) !== kindOf(rest[0][i]?.trim() ?? "")) || first.every((c, i) => rest.every((r) => r[i] !== c));
}

function fixedWidthColumns(ls: string[]): Array<{ start: number; end: number }> | null {
  if (ls.length < 2) return null;
  const width = Math.max(...ls.map((l) => l.length));
  const blank: boolean[] = [];
  for (let i = 0; i < width; i++) blank.push(ls.every((l) => i >= l.length || l[i] === " "));
  const cols: Array<{ start: number; end: number }> = [];
  let start = -1;
  for (let i = 0; i <= width; i++) {
    if (i < width && !blank[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      cols.push({ start, end: i });
      start = -1;
    }
  }
  if (cols.length < 2) return null;
  // Columns abut through the space between them, so each runs to the next one's start.
  return cols.map((c, i) => ({ start: c.start, end: i + 1 < cols.length ? cols[i + 1].start : width + 256 }));
}

export function sniffSyntax(input: Buffer | string): Syntax {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  if (isBinary(buf)) return { format: "binary", magic: buf.subarray(0, 4).toString("hex"), size: buf.length };
  const text = buf.toString("utf8");
  const trimmed = text.trim();
  if (!trimmed) return { format: "text" };
  if (/^[[{]/.test(trimmed)) {
    try {
      const v = JSON.parse(trimmed);
      if (Array.isArray(v) && v.length && v.every(isPlainObject)) return { format: "json-array" };
      if (isPlainObject(v)) {
        const keys = Object.keys(v).filter((k) => Array.isArray(v[k]) && (v[k] as unknown[]).length > 0 && (v[k] as unknown[]).every(isPlainObject));
        if (keys.length === 1) return { format: "json-document", recordsKey: keys[0] };
      }
    } catch {
      /* not one document */
    }
  }
  const ls = lines(text);
  const objects = ls.map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return undefined;
    }
  });
  if (ls.length && objects.every(isPlainObject)) return { format: "ndjson" };
  if (ls.length && ls.every((l) => (l.match(/(^|\s)[A-Za-z_][\w.-]*=/g) ?? []).length >= 2)) return { format: "logfmt" };
  for (const separator of [":", "="]) {
    const pattern = new RegExp(`^[A-Za-z_][\\w .-]*\\s*${separator}(\\s.*|[^\\s=:].*)?$`);
    if (ls.length >= 2 && ls.every((l) => pattern.test(l))) {
      const keys = ls.map((l) => l.slice(0, l.indexOf(separator)).trim());
      // One block has no repeated key to prove itself by; "key: value" lines of plain names still do.
      const plainNames = separator === ":" && keys.every((k) => /^[a-z_][a-z0-9_]*$/.test(k));
      if (new Set(keys).size < keys.length || /\n\s*\n/.test(text.trim()) || plainNames) return { format: "kv-blocks", separator };
    }
  }
  let best: { delimiter: string; cells: number } | null = null;
  for (const d of DELIMITERS) {
    const counts = ls.map((l) => splitDelimited(l, d).length);
    if (counts[0] >= 2 && counts.every((c) => c === counts[0]) && (!best || counts[0] > best.cells)) best = { delimiter: d, cells: counts[0] };
  }
  if (best) {
    const rows = ls.map((l) => splitDelimited(l, best!.delimiter));
    return { format: "delimited", delimiter: best.delimiter, header: looksLikeHeader(rows[0], rows.slice(1)) };
  }
  // One column has no delimiter to find: a name above values of a single kind is still a table.
  if (ls.length >= 2 && /^[A-Za-z_]\w*$/.test(ls[0].trim()) && ls.slice(1).every((l) => ["int", "decimal", "date", "datetime"].includes(kindOf(l)))) return { format: "delimited", delimiter: ",", header: true };
  const cols = fixedWidthColumns(ls);
  if (cols) {
    const firstCells = cols.map((c) => ls[0].slice(c.start, c.end).trim());
    const rest = ls.slice(1).map((l) => cols.map((c) => l.slice(c.start, c.end).trim()));
    const header = looksLikeHeader(firstCells, rest);
    return { format: "fixed-width", header, columns: cols.map((c, i) => ({ name: header ? firstCells[i] : `col${i + 1}`, ...c })) };
  }
  return { format: "text" };
}

// ---------------------------------------------------------------- parsing and rendering

export function parseRecords(input: Buffer | string, syntax: Syntax): Rec[] {
  const text = typeof input === "string" ? input : input.toString("utf8");
  switch (syntax.format) {
    case "ndjson":
      return lines(text).map((l) => flatRecord(JSON.parse(l)));
    case "json-array":
      return (JSON.parse(text) as Array<Record<string, unknown>>).map(flatRecord);
    case "json-document":
      return (JSON.parse(text)[syntax.recordsKey] as Array<Record<string, unknown>>).map(flatRecord);
    case "delimited": {
      const rows = lines(text).map((l) => splitDelimited(l, syntax.delimiter));
      if (!rows.length) return [];
      const names = syntax.header ? rows[0].map((c) => c.trim()) : rows[0].map((_, i) => `col${i + 1}`);
      return (syntax.header ? rows.slice(1) : rows).map((r) => Object.fromEntries(names.map((n, i) => [n, r[i] ?? ""])));
    }
    case "kv-blocks": {
      const out: Rec[] = [];
      let cur: Rec = {};
      const flush = () => {
        if (Object.keys(cur).length) out.push(cur);
        cur = {};
      };
      for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
        if (!raw.trim()) {
          flush();
          continue;
        }
        const at = raw.indexOf(syntax.separator);
        if (at < 0) continue;
        const key = raw.slice(0, at).trim();
        if (key in cur) flush();
        cur[key] = raw.slice(at + 1).trim();
      }
      flush();
      return out;
    }
    case "logfmt":
      return lines(text).map((l) => {
        const rec: Rec = {};
        for (const m of l.matchAll(/([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\S*)/g)) rec[m[1]] = m[2].startsWith('"') ? m[2].slice(1, -1).replace(/\\(.)/g, "$1") : m[2];
        return rec;
      });
    case "fixed-width": {
      const ls = lines(text);
      return (syntax.header ? ls.slice(1) : ls).map((l) => Object.fromEntries(syntax.columns.map((c) => [c.name, l.slice(c.start, c.end).trim()])));
    }
    default:
      return [];
  }
}

const quoteCell = (v: string, d: string): string => (v.includes(d) || v.includes('"') || v.includes("\n") ? `"${v.replace(/"/g, '""')}"` : v);

export const cellText = (v: Scalar | undefined): string => (v === null || v === undefined ? "" : String(v));

/** Render records in a syntax. `names` fixes column order for formats that have one. */
export function renderRecords(records: Rec[], syntax: Syntax, names?: string[]): string {
  const cols = names ?? [...new Set(records.flatMap((r) => Object.keys(r)))];
  switch (syntax.format) {
    case "ndjson":
      return records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
    case "json-array":
      return `${JSON.stringify(records)}\n`;
    case "json-document":
      return `${JSON.stringify({ [syntax.recordsKey]: records })}\n`;
    case "delimited": {
      const body = records.map((r) => cols.map((c) => quoteCell(cellText(r[c]), syntax.delimiter)).join(syntax.delimiter));
      return [...(syntax.header ? [cols.join(syntax.delimiter)] : []), ...body].join("\n") + "\n";
    }
    case "kv-blocks":
      return records.map((r) => cols.map((c) => `${c}${syntax.separator} ${cellText(r[c])}`).join("\n")).join("\n\n") + "\n";
    case "logfmt":
      return records.map((r) => cols.map((c) => {
        const t = cellText(r[c]);
        return `${c}=${/[\s"]/.test(t) || t === "" ? JSON.stringify(t) : t}`;
      }).join(" ")).join("\n") + "\n";
    case "fixed-width": {
      const pad = (t: string, c: { start: number; end: number }, last: boolean) => (last ? t : t.padEnd(c.end - c.start).slice(0, c.end - c.start));
      const row = (cells: string[]) => cells.map((t, i) => pad(t, syntax.columns[i], i === syntax.columns.length - 1)).join("").trimEnd();
      const body = records.map((r) => row(syntax.columns.map((c) => cellText(r[c.name]))));
      return [...(syntax.header ? [row(syntax.columns.map((c) => c.name))] : []), ...body].join("\n") + "\n";
    }
    default:
      throw new Error(`cannot render records as ${syntax.format}`);
  }
}

// ---------------------------------------------------------------- field shapes

export function kindOf(raw: string): FieldKind {
  const s = raw.trim();
  if (s === "") return "empty";
  if (/^-?(0|[1-9]\d*)$/.test(s)) return "int";
  if (/^-?\d*\.\d+$/.test(s)) return "decimal";
  if (/^(true|false)$/i.test(s)) return "bool";
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "date";
  if (/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(s)) return "datetime";
  return "string";
}

const RANK: FieldKind[] = ["empty", "int", "decimal", "string"];

function joinKinds(a: FieldKind, b: FieldKind): FieldKind {
  if (a === b || b === "empty") return a;
  if (a === "empty") return b;
  const [x, y] = [RANK.indexOf(a), RANK.indexOf(b)];
  if (x >= 0 && y >= 0) return RANK[Math.max(x, y)];
  return "string";
}

export function fieldsOf(records: Rec[]): Field[] {
  const names = [...new Set(records.flatMap((r) => Object.keys(r)))];
  return names.map((name) => {
    const values = records.map((r) => r[name]).filter((v) => v !== undefined).map(cellText);
    let kind: FieldKind = "empty";
    let decimals = 0;
    let min = Infinity;
    let max = -Infinity;
    for (const v of values) {
      const k = kindOf(v);
      kind = joinKinds(kind, k);
      if (k === "int" || k === "decimal") {
        const n = Number(v);
        min = Math.min(min, n);
        max = Math.max(max, n);
        decimals = Math.max(decimals, v.trim().split(".")[1]?.length ?? 0);
      }
    }
    const distinct = [...new Set(values)];
    return {
      name, kind, cardinality: distinct.length, samples: distinct.slice(0, 5),
      ...(kind === "decimal" ? { decimals } : {}),
      ...(Number.isFinite(min) ? { min, max } : {}),
    };
  });
}

export function sniff(input: Buffer | string): Repr {
  const syntax = sniffSyntax(input);
  if (syntax.format === "text" || syntax.format === "binary") return { syntax, fields: [], records: 0 };
  const records = parseRecords(input, syntax);
  return { syntax, fields: fieldsOf(records), records: records.length };
}

// ---------------------------------------------------------------- relations between representations

export function sameSyntax(a: Syntax, b: Syntax): boolean {
  if (a.format !== b.format) return false;
  if (a.format === "delimited" && b.format === "delimited") return a.delimiter === b.delimiter && a.header === b.header;
  if (a.format === "kv-blocks" && b.format === "kv-blocks") return a.separator === b.separator;
  if (a.format === "json-document" && b.format === "json-document") return a.recordsKey === b.recordsKey;
  return true;
}

const tokens = (name: string): string[] => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** Name affinity of two field names, 0..1. Evidence for ranking, never proof of equal meaning. */
export function nameAffinity(a: string, b: string): number {
  const [x, y] = [new Set(tokens(a)), new Set(tokens(b))];
  if (!x.size || !y.size) return 0;
  const shared = [...x].filter((t) => y.has(t) || [...y].some((u) => t.length >= 3 && u.length >= 3 && (t.startsWith(u) || u.startsWith(t)))).length;
  return shared / Math.max(x.size, y.size);
}

/** Fraction of target fields with a source field of a compatible kind or a related name. */
export function fieldCoverage(source: Repr, target: Repr): number {
  if (!target.fields.length) return 0;
  const matched = target.fields.filter((t) =>
    source.fields.some((s) => nameAffinity(s.name, t.name) > 0 || valuesOverlap(s, t) || (numeric(s) && numeric(t)))).length;
  return matched / target.fields.length;
}

const numeric = (f: Field): boolean => f.kind === "int" || f.kind === "decimal";
const valuesOverlap = (a: Field, b: Field): boolean => a.samples.some((v) => v !== "" && b.samples.includes(v));

/** Does a value of `actual` already satisfy a requirement of `required` shape? */
export function reprFits(actual: Repr, required: Repr, requiredFields?: string[]): boolean {
  if (!sameSyntax(actual.syntax, required.syntax)) return false;
  const names = requiredFields ?? required.fields.map((f) => f.name);
  return names.every((n) => actual.fields.some((f) => f.name === n));
}

export interface RecordDiff {
  row: number;
  field: string;
  expected: Scalar | undefined;
  actual: Scalar | undefined;
}

const asNumber = (v: Scalar | undefined): number | undefined => {
  if (typeof v === "number") return v;
  if (typeof v === "string" && /^-?\d*\.?\d+(e-?\d+)?$/i.test(v.trim())) return Number(v);
  return undefined;
};

const placesOf = (v: Scalar | undefined): number => (v === null || v === undefined ? 0 : String(v).trim().split(".")[1]?.length ?? 0);

/** Scalars equal as text, or as numbers within one unit in the last place the reference states. */
export function scalarEqual(expected: Scalar | undefined, actual: Scalar | undefined, ulps = 1): boolean {
  if (cellText(expected).trim() === cellText(actual).trim()) return true;
  const [e, a] = [asNumber(expected), asNumber(actual)];
  if (e === undefined || a === undefined) return false;
  return Math.abs(e - a) <= ulps * 1.0001 * 10 ** -placesOf(expected);
}

/** Compare two record lists row by row; differences are the evidence a counterexample carries. */
export function compareRecords(expected: Rec[], actual: Rec[], opts: { fields?: string[]; ulps?: number; limit?: number; tolerance?: Record<string, number> } = {}): { equal: boolean; diffs: RecordDiff[]; rowsCompared: number } {
  const diffs: RecordDiff[] = [];
  const limit = opts.limit ?? 8;
  if (expected.length !== actual.length) diffs.push({ row: -1, field: "(record count)", expected: expected.length, actual: actual.length });
  const rows = Math.min(expected.length, actual.length);
  for (let i = 0; i < rows && diffs.length < limit; i++) {
    for (const f of opts.fields ?? Object.keys(expected[i])) {
      const slack = opts.tolerance?.[f];
      const near = slack !== undefined && Math.abs(Number(expected[i][f]) - Number(actual[i][f])) <= slack;
      if (!near && !scalarEqual(expected[i][f], actual[i][f], opts.ulps)) {
        diffs.push({ row: i, field: f, expected: expected[i][f], actual: actual[i][f] });
        if (diffs.length >= limit) break;
      }
    }
  }
  return { equal: diffs.length === 0, diffs, rowsCompared: rows };
}
