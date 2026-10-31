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
  offset: number;
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

/** The stride and first-record offset that explain where the first text column recurs. */
function findStride(bytes: Buffer, records: Rec[], names: string[], counter: { n: number }): { stride: number; origin: number } | null {
  for (const name of names) {
    const values = records.map((r) => cellText(r[name]).trim());
    if (values.some((v) => v.length < 2) || new Set(values).size < Math.min(3, values.length)) continue;
    for (const first of occurrences(bytes, Buffer.from(values[0]))) {
      for (const second of occurrences(bytes, Buffer.from(values[1]))) {
        const stride = second - first;
        counter.n++;
        if (stride <= 0) continue;
        if (values.every((v, i) => {
          const at = first + i * stride;
          return at + v.length <= bytes.length && bytes.subarray(at, at + v.length).toString("latin1") === Buffer.from(v).toString("latin1");
        })) return { stride, origin: first };
      }
    }
  }
  return null;
}

function locate(bytes: Buffer, records: Rec[], names: string[], origin: number, stride: number): { start: number; fields: Located[] } | null {
  // The record starts at or before the anchor; try each start that keeps the file a whole number of records.
  for (let start = origin; start >= Math.max(0, origin - stride); start--) {
    const remainder = bytes.length - start - records.length * stride;
    if (remainder < 0 || remainder > 16) continue;
    const fields: Located[] = [];
    for (const name of names) {
      const texts = records.map((r) => cellText(r[name]).trim());
      const sample = texts.find((t) => t.length) ?? "";
      const row0 = bytes.subarray(start, start + stride).toString("latin1");
      const firstAt = sample ? [...row0.matchAll(new RegExp(sample.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))].map((m) => m.index!) : [];
      let found: Located | null = null;
      for (const at of firstAt) {
        const rows = records.map((_, i) => bytes.subarray(start + i * stride, start + (i + 1) * stride).toString("latin1"));
        if (rows.every((row, i) => row.slice(at).trimStart().startsWith(texts[i]) || texts[i] === "")) {
          let width = stride - at;
          for (const other of names) if (other !== name) {
            const o = fields.find((f) => f.name === other);
            if (o && o.offset > at) width = Math.min(width, o.offset - at);
          }
          found = { name, offset: at, width };
          break;
        }
      }
      if (!found && !sample) found = { name, offset: -1, width: 0 };
      if (!found) return null;
      fields.push(found);
    }
    return { start, fields: fields.sort((a, b) => a.offset - b.offset) };
  }
  return null;
}

function integerSlots(files: Buffer[], want: number[], limit: number, counter: { n: number }): Slot[] {
  const out: Slot[] = [];
  for (let offset = 0; offset < Math.min(limit, 64); offset++) {
    for (const bytes of [1, 2, 4]) for (const little of bytes === 1 ? [true] : [true, false]) {
      const s: Slot = { offset, bytes, little };
      counter.n++;
      if (files.every((f, i) => offset + bytes <= f.length && readInt(f, s) === want[i])) out.push(s);
    }
  }
  return out;
}

/** A table of equal-sized entries in the header, one per field, each beginning with its name. */
function findDescriptorTable(file: Buffer, headerEnd: number, names: string[], counter: { n: number }): { start: number; entry: number; nameBytes: number } | null {
  const at = names.map((n) => file.subarray(0, headerEnd).indexOf(Buffer.from(n)));
  if (at.some((x) => x < 0)) return null;
  const entry = at[1] - at[0];
  if (names.length < 2 || entry <= 0) return null;
  counter.n++;
  if (!at.every((x, i) => x === at[0] + i * entry)) return null;
  return { start: at[0], entry, nameBytes: entry };
}

function widthSlot(file: Buffer, table: { start: number; entry: number }, fields: Located[], counter: { n: number }): number | null {
  const ordered = fields.filter((f) => f.offset >= 0);
  const widths = ordered.map((f, i) => (i + 1 < ordered.length ? ordered[i + 1].offset - f.offset : null));
  for (let k = 0; k < table.entry; k++) {
    counter.n++;
    if (ordered.every((_, i) => widths[i] === null || file[table.start + i * table.entry + k] === widths[i])) return k;
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
    if (!name) break; // the first entry that names nothing ends the table
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
  const files = pairs.map((p) => Buffer.from(p.input, "base64"));
  const truth = pairs.map((p) => parseRecords(p.output, sniffSyntax(p.output)));
  const names = Object.keys(truth[0][0] ?? {});
  if (!names.length) return { ok: false, reason: "the examples contain no records", explored: 0 };
  const per = files.map((f, i) => {
    const anchor = findStride(f, truth[i], Object.keys(truth[i][0] ?? {}), counter);
    if (!anchor) return null;
    const placed = locate(f, truth[i], Object.keys(truth[i][0] ?? {}), anchor.origin, anchor.stride);
    return placed ? { ...anchor, ...placed } : null;
  });
  const ok = per.findIndex((p) => p);
  if (ok < 0) return { ok: false, reason: "no fixed record stride explains where the known values occur", explored: counter.n };
  const usable = per.flatMap((p, i) => (p ? [{ p, file: files[i], rows: truth[i] }] : []));
  const programs: LayoutProgram[] = [];
  const count = integerSlots(usable.map((u) => u.file), usable.map((u) => u.rows.length), 32, counter);
  const recordSize = integerSlots(usable.map((u) => u.file), usable.map((u) => u.p.stride), 32, counter);
  const headerSize = integerSlots(usable.map((u) => u.file), usable.map((u) => u.p.start), 32, counter);
  const headerSizes = headerSize.length ? headerSize : usable[0].p.start > 0 ? integerSlots(usable.map((u) => u.file), usable.map((u) => u.p.start + 0), 32, counter) : [];
  const first = usable[0];
  const table = findDescriptorTable(first.file, first.p.start, first.p.fields.filter((f) => f.offset >= 0).map((f) => f.name), counter);
  const widthAt = table ? widthSlot(first.file, table, first.p.fields, counter) : null;
  if (count.length && recordSize.length && headerSizes.length && table && widthAt !== null) {
    const firstField = first.p.fields.filter((f) => f.offset >= 0)[0];
    // Bytes in a record before its first described field, such as a status marker.
    programs.push({
      source: emitDescribed({ count: count[0], headerSize: headerSizes[0], recordSize: recordSize[0], table, widthAt, firstOffset: firstField.offset }),
      explanation: [`record count at byte ${count[0].offset} (${count[0].bytes} bytes)`, `header size at byte ${headerSizes[0].offset}`, `record size at byte ${recordSize[0].offset}`, `field table at byte ${table.start} with ${table.entry}-byte entries`, `field width at entry byte ${widthAt}`],
    });
  }
  programs.push({
    source: emitFixed(first.p.start, first.p.stride, first.p.fields, count[0] ?? null),
    explanation: [`fixed layout: ${first.p.fields.length} fields, ${first.p.stride}-byte records from byte ${first.p.start}`],
  });
  return { ok: true, programs, explored: counter.n };
}
