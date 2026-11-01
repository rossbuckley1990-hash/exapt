// Deterministic recovery of fixed-record binary formats from worked examples.
//
// Given files and the records they are known to contain, this works out how the bytes are laid out
// by testing hypotheses against the examples, with no knowledge of any format: find the record
// stride from where known values recur; locate each field inside a record; then look for a header
// that describes the layout, by searching for integer slots that equal the record count, the record
// size and the header size in every example, and for a table of fixed-size entries that names the
// fields and states their widths. If such a self-description is found the emitted program reads it,
// and can generalise to files with other schemas. If not, the program is bound to the example
// schema, and the experiments on unseen files will establish which of these it is.
import { cellText, parseRecords, sniffSyntax, type Rec } from "../capability-universe/repr.ts";

interface Located {
  name: string;
  /** Where the value starts on the row where it starts earliest. */
  offset: number;
  /** Trailing padding in the previous column can't be told apart from leading padding in this one,
   *  so the column's true start is only known to lie in lowest..offset. */
  lowest: number;
  width: number;
}

interface Slot {
  offset: number;
  bytes: number;
  little: boolean;
}

export interface LayoutProgram {
  source: string;
  explanation: string[];
}

export type LayoutResult = { ok: true; programs: LayoutProgram[]; explored: number } | { ok: false; reason: string; explored: number };

const readInt = (b: Buffer, s: Slot): number => (s.bytes === 1 ? b[s.offset] : s.bytes === 2 ? (s.little ? b.readUInt16LE(s.offset) : b.readUInt16BE(s.offset)) : s.little ? b.readUInt32LE(s.offset) : b.readUInt32BE(s.offset));

function occurrences(hay: Buffer, needle: Buffer, limit = 64): number[] {
  const out: number[] = [];
  let at = hay.indexOf(needle);
  while (at >= 0 && out.length < limit) {
    out.push(at);
    at = hay.indexOf(needle, at + 1);
  }
  return out;
}

/** Bytes of a value as they would sit in a latin1 view of the file. */
const asBytes = (v: string): string => Buffer.from(v).toString("latin1");

/** Offsets inside the record from which a field's value can be read on every row. */
function fieldOffsets(rows: string[], texts: string[]): number[] {
  const known = texts.map((t, i) => ({ t: asBytes(t), i })).filter((x) => x.t);
  if (!known.length) return [];
  const first = known[0];
  for (let at = rows[first.i].indexOf(first.t); at >= 0; at = rows[first.i].indexOf(first.t, at + 1)) {
    const out: number[] = [];
    // Values may be padded on the left, so a value's own start need not be the field's start.
    for (let start = at; start >= 0; start--) {
      if (rows[first.i].slice(start, at).trim() !== "") break;
      if (known.every(({ t, i }) => rows[i].slice(start).trimStart().startsWith(t))) out.push(start);
    }
    if (out.length) return out.sort((a, b) => a - b);
  }
  return [];
}

interface Layout {
  start: number;
  stride: number;
  fields: Located[];
}

/** Record sizes suggested by where one column's values recur: two values r rows apart, d bytes
 *  apart, suggest d/r bytes per record. */
function strideCandidates(view: string, texts: string[][], counter: { n: number }): number[] {
  const out = new Map<number, number>();
  const columns = texts.map((t, i) => ({ i, t })).sort((a, b) => Math.max(...b.t.map((v) => v.length)) - Math.max(...a.t.map((v) => v.length))).slice(0, 8);
  for (const { t } of columns) {
    const rows = t.map((v, r) => ({ v: asBytes(v), r })).filter((x) => x.v.length >= 2).sort((a, b) => b.v.length - a.v.length).slice(0, 6);
    for (let x = 0; x < rows.length; x++) for (let y = x + 1; y < rows.length; y++) {
      const [a, b] = rows[x].r < rows[y].r ? [rows[x], rows[y]] : [rows[y], rows[x]];
      if (a.r === b.r) continue;
      for (const p of allAt(view, a.v)) for (const q of allAt(view, b.v)) {
        counter.n++;
        const d = (q - p) / (b.r - a.r);
        if (d > 0 && Number.isInteger(d)) out.set(d, (out.get(d) ?? 0) + 1);
      }
    }
  }
  return [...out].sort((a, b) => b[1] - a[1]).map(([d]) => d).slice(0, 24);
}

function allAt(view: string, needle: string, limit = 24): number[] {
  const out: number[] = [];
  for (let at = view.indexOf(needle); at >= 0 && out.length < limit; at = view.indexOf(needle, at + 1)) out.push(at);
  return out;
}

/** Find the layout: a record size and start that the file's length allows, under which the example's
 *  values line up in fixed columns. */
function findLayouts(bytes: Buffer, records: Rec[], names: string[], counter: { n: number }): Layout[] {
  const n = records.length;
  if (!n) return [];
  const view = bytes.toString("latin1");
  const texts = names.map((name) => records.map((r) => cellText(r[name]).trim()));
  const needed = Math.max(1, Math.ceil(names.filter((_, i) => texts[i].some((t) => t)).length * 0.5));
  const attempt = (stride: number, start: number) => {
    counter.n++;
    const rows = records.map((_, r) => view.slice(start + r * stride, start + (r + 1) * stride));
    const fields: Located[] = [];
    for (const [i, name] of names.entries()) {
      const offsets = fieldOffsets(rows, texts[i]);
      if (offsets.length) fields.push({ name, offset: offsets[offsets.length - 1], lowest: offsets[0], width: 0 });
    }
    if (fields.length < needed) return null;
    fields.sort((a, b) => a.offset - b.offset);
    fields.forEach((f, i) => (f.width = (fields[i + 1]?.offset ?? stride) - f.offset));
    return { start, stride, fields };
  };
  // A file may end in a few bytes of trailer, and padding can hide a one-byte error in where the
  // records begin, so every start that fits is kept for the header to settle.
  const fits = (stride: number): Layout[] => {
    const out: Layout[] = [];
    for (let tail = 0; tail <= 16; tail++) {
      const start = bytes.length - tail - n * stride;
      if (start < 0) break;
      const found = attempt(stride, start);
      if (found) out.push(found);
    }
    return out;
  };
  for (const stride of strideCandidates(view, texts, counter)) {
    const found = fits(stride);
    if (found.length) return found;
  }
  // Nothing recurs usefully, as in a table of constants: fall back to what the file's length allows.
  for (let stride = Math.min(1024, Math.floor(bytes.length / n)); stride >= 1; stride--) {
    const found = fits(stride);
    if (found.length) return found;
  }
  return [];
}

function integerSlots(files: Buffer[], want: Array<Set<number>>, limit: number, counter: { n: number }): Slot[] {
  const out: Slot[] = [];
  for (let offset = 0; offset < Math.min(limit, 64); offset++) {
    for (const bytes of [4, 2, 1]) for (const little of bytes === 1 ? [true] : [true, false]) {
      const s: Slot = { offset, bytes, little };
      counter.n++;
      if (files.every((f, i) => offset + bytes <= f.length && want[i].has(readInt(f, s)))) out.push(s);
    }
  }
  // Across several files only real slots survive. On one file, prefer the reading with the most
  // room: a wider slot that matches is less likely to be a coincidence than a narrow one.
  return out.sort((a, b) => Number(b.little) - Number(a.little) || b.bytes - a.bytes || a.offset - b.offset);
}

const NAME = /^[A-Za-z_][\w ]*$/;

/** The name at the start of a table entry, read up to the first byte that cannot be in a name. */
function entryName(file: Buffer, at: number, entry: number): string {
  const raw = file.subarray(at, at + entry);
  const end = raw.findIndex((c) => c < 0x20 || c > 0x7e);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("latin1").trim();
}

interface Table {
  start: number;
  entry: number;
  names: string[];
}

/** A table of equal-sized entries in the header, each beginning with a field name, found from the
 *  names the example says exist. The file's own order and full list come from the table itself. */
function findDescriptorTable(file: Buffer, headerEnd: number, names: string[], counter: { n: number }): Table | null {
  const usable = names.filter((n) => n.length >= 2);
  if (usable.length < 2) return null;
  const header = file.subarray(0, headerEnd);
  for (const a of usable.slice(0, 4)) for (const b of usable.slice(1, 6)) {
    if (a === b) continue;
    for (const p of occurrences(header, Buffer.from(`${a}\0`))) for (const q of occurrences(header, Buffer.from(`${b}\0`))) {
      const entry = Math.abs(q - p);
      counter.n++;
      if (entry < 8 || entry > 256) continue;
      let start = Math.min(p, q);
      while (start - entry >= 0 && NAME.test(entryName(file, start - entry, entry))) start -= entry;
      const found: string[] = [];
      for (let at = start; at + entry <= headerEnd; at += entry) {
        const name = entryName(file, at, entry);
        if (!NAME.test(name)) break;
        found.push(name);
      }
      const known = names.filter((n) => found.includes(n)).length;
      if (known >= names.length * 0.7) return { start, entry, names: found };
    }
  }
  return null;
}

/** The byte in each entry that is that field's width: added up in table order, the widths must
 *  fill the record, up to a small lead-in, and land inside every located field's possible start. */
function widthSlot(file: Buffer, table: Table, located: Located[], stride: number, counter: { n: number }): { slot: number; lead: number } | null {
  for (let k = 0; k < table.entry; k++) {
    counter.n++;
    let total = 0;
    const at = new Map<string, number>();
    for (const [i, name] of table.names.entries()) {
      at.set(name, total);
      total += file[table.start + i * table.entry + k] ?? 0;
    }
    const lead = stride - total;
    if (lead < 0 || lead > 8) continue;
    if (located.every((f) => {
      const start = at.get(f.name);
      return start === undefined || (start + lead >= f.lowest && start + lead <= f.offset);
    })) return { slot: k, lead };
  }
  return null;
}

const slotCode = (s: Slot): string => (s.bytes === 1 ? `b[${s.offset}]` : `b.readUInt${s.bytes * 8}${s.bytes === 1 ? "" : s.little ? "LE" : "BE"}(${s.offset})`);

function emitDescribed(o: { count: Slot; headerSize: Slot; recordSize: Slot; table: { start: number; entry: number }; widthAt: number; firstOffset: number }): string {
  return `// Synthesised by EXAPT's binary layout induction. The layout below was inferred from examples,
// including the finding that the file's own header describes its fields.
export function transform(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input, "latin1");
  if (b.length < ${o.table.start}) throw new Error("truncated header");
  const count = ${slotCode(o.count)}, headerSize = ${slotCode(o.headerSize)}, recordSize = ${slotCode(o.recordSize)};
  if (recordSize <= 0 || headerSize > b.length || headerSize + count * recordSize > b.length) throw new Error("file is shorter than its header states");
  const fields = [];
  let offset = ${o.firstOffset};
  for (let p = ${o.table.start}; p + ${o.table.entry} <= headerSize; p += ${o.table.entry}) {
    const raw = b.subarray(p, p + ${o.table.entry});
    const end = raw.findIndex((c) => c < 0x20 || c > 0x7e);
    const name = raw.subarray(0, end < 0 ? raw.length : end).toString("latin1").trim();
    if (!/^[A-Za-z_][\\w ]*$/.test(name)) break; // the first entry that names nothing ends the table
    const width = b[p + ${o.widthAt}];
    fields.push({ name, offset, width });
    offset += width;
  }
  if (!fields.length) throw new Error("no fields described in the header");
  const rows = [];
  for (let i = 0; i < count; i++) {
    const start = headerSize + i * recordSize;
    const row = {};
    for (const f of fields) row[f.name] = b.subarray(start + f.offset, start + f.offset + f.width).toString("utf8").replace(/\\0+$/, "").trim();
    rows.push(JSON.stringify(row));
  }
  return rows.join("\\n") + "\\n";
}
`;
}

function emitFixed(start: number, stride: number, fields: Located[], recordCount: Slot | null): string {
  return `// Synthesised by EXAPT's binary layout induction. Field positions are bound to the example schema.
const FIELDS = ${JSON.stringify(fields.filter((f) => f.offset >= 0))};
export function transform(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input, "latin1");
  const count = ${recordCount ? slotCode(recordCount) : `Math.floor((b.length - ${start}) / ${stride})`};
  if (${start} + count * ${stride} > b.length) throw new Error("truncated file");
  const rows = [];
  for (let i = 0; i < count; i++) {
    const at = ${start} + i * ${stride};
    const row = {};
    for (const f of FIELDS) row[f.name] = b.subarray(at + f.offset, at + f.offset + f.width).toString("utf8").replace(/\\0+$/, "").trim();
    rows.push(JSON.stringify(row));
  }
  return rows.join("\\n") + "\\n";
}
`;
}

export function induceLayout(pairs: Array<{ input: string; output: string; binary?: boolean }>): LayoutResult {
  const counter = { n: 0 };
  if (!pairs.length) return { ok: false, reason: "no worked examples", explored: 0 };
  const worked = pairs.map((p) => {
    const file = Buffer.from(p.input, "base64");
    const rows = parseRecords(p.output, sniffSyntax(p.output));
    const names = Object.keys(rows[0] ?? {});
    return { file, rows, names, layouts: rows.length ? findLayouts(file, rows, names, counter) : [] };
  });
  const usable = worked.filter((w) => w.layouts.length);
  if (!usable.length) return { ok: false, reason: "no fixed record layout explains where the known values occur", explored: counter.n };
  const files = usable.map((u) => u.file);
  const count = integerSlots(files, usable.map((u) => new Set([u.rows.length])), 32, counter);
  const recordSize = integerSlots(files, usable.map((u) => new Set(u.layouts.map((l) => l.stride))), 32, counter);
  const headerSize = integerSlots(files, usable.map((u) => new Set(u.layouts.map((l) => l.start))), 32, counter);
  const programs: LayoutProgram[] = [];
  const settled = (u: (typeof usable)[number]): Layout => u.layouts.find((l) => headerSize[0] && l.start === readInt(u.file, headerSize[0])) ?? u.layouts[0];
  const described = usable.flatMap((u) => {
    const layout = settled(u);
    const table = findDescriptorTable(u.file, layout.start, u.names, counter);
    const width = table ? widthSlot(u.file, table, layout.fields, layout.stride, counter) : null;
    return table && width ? [{ table, width }] : [];
  })[0];
  if (count.length && recordSize.length && headerSize.length && described) {
    const { table, width } = described;
    programs.push({
      source: emitDescribed({ count: count[0], headerSize: headerSize[0], recordSize: recordSize[0], table, widthAt: width.slot, firstOffset: width.lead }),
      explanation: [`record count at byte ${count[0].offset} (${count[0].bytes} bytes)`, `header size at byte ${headerSize[0].offset}`, `record size at byte ${recordSize[0].offset}`, `field table at byte ${table.start}, ${table.entry}-byte entries`, `field width at entry byte ${width.slot}`, `${width.lead} byte(s) of lead-in before the first field`],
    });
  }
  const first = usable[0];
  const fixed = settled(first);
  if (fixed.fields.length === first.names.length) programs.push({
    source: emitFixed(fixed.start, fixed.stride, fixed.fields, count[0] ?? null),
    explanation: [`fixed layout: ${fixed.fields.length} fields in ${fixed.stride}-byte records from byte ${fixed.start}`],
  });
  if (!programs.length) return { ok: false, reason: "a record layout was found, but neither a self-description nor all field positions could be established", explored: counter.n };
  return { ok: true, programs, explored: counter.n };
}
