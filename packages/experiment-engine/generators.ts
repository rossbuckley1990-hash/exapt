// Test inputs. Everything is seeded and reproducible. Nothing here reads a candidate: inputs are
// derived from the environment's own samples, so a program cannot shape the tests that judge it.
import { cellText, isRecordRepr, parseRecords, renderRecords, type Field, type Rec, type Repr } from "../capability-universe/repr.ts";
import type { Rng } from "../shared/index.ts";

const WORDS = ["alpha", "bravo", "cedar", "delta", "ember", "flint", "grove", "harbor", "indigo", "juniper", "kestrel", "lumen", "maple", "north", "onyx", "prairie"];

function perturbNumber(raw: string, rng: Rng, spread: number): string {
  const decimals = raw.split(".")[1]?.length ?? 0;
  const value = Number(raw) + (rng.next() * 2 - 1) * spread;
  return value.toFixed(decimals);
}

function freshValue(f: Field, rng: Rng): string {
  const sample = f.samples.length ? rng.pick(f.samples) : "";
  switch (f.kind) {
    case "int": {
      if ((f.min ?? 0) > 1e8) return String(Math.round(Number(sample) + rng.int(-5_000_000, 5_000_000)));
      const spread = Math.max(10, ((f.max ?? 10) - (f.min ?? 0)) * 2);
      const v = Math.round(Number(sample) + (rng.next() * 2 - 1) * spread);
      return String((f.min ?? 0) >= 0 ? Math.abs(v) : v);
    }
    case "decimal": {
      const spread = Math.max(1, ((f.max ?? 1) - (f.min ?? 0)) * 2);
      const v = Number(sample) + (rng.next() * 2 - 1) * spread;
      return ((f.min ?? 0) >= 0 ? Math.abs(v) : v).toFixed(f.decimals ?? 2);
    }
    case "datetime":
    case "date": {
      const local = /^(\d{2})([/.])(\d{2})\2(\d{4})$/.exec(sample);
      if (local) {
        const dayFirst = f.samples.some((v) => Number(v.slice(0, 2)) > 12);
        const [a, b] = dayFirst ? [rng.int(1, 28), rng.int(1, 12)] : [rng.int(1, 12), rng.int(1, 12)];
        return `${String(a).padStart(2, "0")}${local[2]}${String(b).padStart(2, "0")}${local[2]}${local[4]}`;
      }
      if (Number.isNaN(Date.parse(sample))) return sample;
      const t = Date.parse(sample) + rng.int(-200, 200) * 86_400_000 + rng.int(0, 86_399) * 1000;
      const iso = new Date(t).toISOString();
      return f.kind === "date" ? iso.slice(0, 10) : iso.replace(".000Z", "Z");
    }
    case "bool":
      return rng.bool() ? "true" : "false";
    default:
      return f.samples.length ? varyText(f.samples, rng) : rng.pick(WORDS);
  }
}

const TOKEN = /[A-Za-z]{2,}|\d+/g;

/** A new value shaped like the samples. Only what varies among them is varied: a token that is the
 *  same in every sample is structure, such as a prefix, and changing it would leave the domain. */
function varyText(samples: string[], rng: Rng): string {
  const base = rng.pick(samples);
  if (samples.length < 2) return base.replace(/\d+/g, (d) => String(rng.int(0, 10 ** Math.min(d.length, 6) - 1)).padStart(d.length, "0"));
  const tokenised = samples.map((x) => x.match(TOKEN) ?? []);
  let i = -1;
  return base.replace(TOKEN, (tok) => {
    i++;
    const here = tokenised.map((t) => t[i]);
    if (here.every((t) => t === tok)) return tok;
    if (/^\d/.test(tok)) return String(rng.int(0, 10 ** Math.min(tok.length, 6) - 1)).padStart(tok.length, "0");
    return rng.bool(0.3) ? tok : matchCase(rng.pick(WORDS), tok);
  });
}

const matchCase = (word: string, like: string): string => (like === like.toUpperCase() ? word.toUpperCase() : like[0] === like[0].toUpperCase() ? word[0].toUpperCase() + word.slice(1) : word);

const typedValue = (original: unknown, text: string): string | number | boolean | null => {
  if (typeof original === "number") return Number(text);
  if (typeof original === "boolean") return text === "true";
  return text;
};

/** New records with the same shape as a sample: same syntax, same kinds, different values. */
export function generateRecords(sample: string, repr: Repr, rng: Rng, rows: number): string {
  const records = parseRecords(sample, repr.syntax);
  const template = records[0] ?? {};
  const names = repr.fields.map((f) => f.name);
  const out: Rec[] = [];
  for (let i = 0; i < rows; i++) {
    const rec: Rec = {};
    for (const f of repr.fields) rec[f.name] = typedValue(template[f.name], freshValue(f, rng));
    out.push(rec);
  }
  return renderRecords(out, repr.syntax, names);
}

/** New values for text without a parseable record syntax: keep each line's structure, vary its
 *  numbers and words. Used for an upstream program's own input format. */
export function generateLines(sample: string, rng: Rng, rows: number): string {
  const lines = sample.split(/\r?\n/).filter((l) => l.trim());
  const SHAPE = /-?\d+(?:\.\d+)?|[A-Za-z]{3,}/g;
  const tokenised = lines.map((l) => l.match(SHAPE) ?? []);
  const out: string[] = [];
  for (let n = 0; n < rows; n++) {
    let i = -1;
    out.push(rng.pick(lines).replace(SHAPE, (tok) => {
      i++;
      const here = tokenised.map((t) => t[i]);
      if (lines.length > 1 && here.every((t) => t === tok)) return tok;
      if (/^-?\d/.test(tok)) {
        if (tok.length >= 9 && !tok.includes(".")) return String(Number(tok) + rng.int(-2_000_000, 2_000_000));
        return perturbNumber(tok, rng, Math.max(1, Math.abs(Number(tok)) * 0.4));
      }
      return rng.bool(0.5) ? tok : matchCase(rng.pick(WORDS), tok);
    }));
  }
  return `${out.join("\n")}\n`;
}

export const generateLike = (sample: string, repr: Repr, rng: Rng, rows: number): string => (isRecordRepr(repr) && repr.syntax.format !== "logfmt" ? generateRecords(sample, repr, rng, rows) : generateLines(sample, rng, rows));

export interface NamedInput {
  name: string;
  input: string;
  /** Text this case appends to a field; a correct program must carry it through intact. */
  mark?: string;
}

/** Valid but extreme: every oracle still applies to these. */
export function boundaryInputs(sample: string, repr: Repr, rng: Rng): NamedInput[] {
  if (!isRecordRepr(repr)) return [];
  const records = parseRecords(sample, repr.syntax);
  const names = repr.fields.map((f) => f.name);
  const render = (rs: Rec[]) => renderRecords(rs, repr.syntax, names);
  const out: NamedInput[] = [
    { name: "one record", input: render(records.slice(0, 1)) },
    { name: "many records", input: generateRecords(sample, repr, rng, 400) },
    { name: "windows line endings", input: render(records).replace(/\n/g, "\r\n") },
    { name: "no trailing newline", input: render(records).replace(/\n$/, "") },
  ];
  // Appended, not prepended: a value's leading structure is part of what makes it valid.
  const text = repr.fields.find((f) => f.kind === "string");
  if (text) {
    const appended = (name: string, mark: string) => out.push({ name, mark, input: render(records.map((r) => ({ ...r, [text.name]: `${cellText(r[text.name])}${mark}` }))) });
    appended("non-ascii text", "-Zürich東京");
    appended("spaces inside text", " two words");
  }
  if (repr.syntax.format === "delimited" && text) {
    const { delimiter } = repr.syntax;
    const appended = (name: string, mark: string) => out.push({ name, mark, input: render(records.map((r) => ({ ...r, [text.name]: `${cellText(r[text.name])}${mark}` }))) });
    appended("delimiter and quotes inside text", `${delimiter}say "hi"`);
  }
  out.push({ name: "blank lines between records", input: render(records).replace(/\n(?=.)/g, "\n\n") });
  const numeric = repr.fields.find((f) => f.kind === "decimal" || (f.kind === "int" && (f.min ?? 0) < 1e8));
  if (numeric) {
    out.push({ name: "zero values", input: render(records.map((r) => ({ ...r, [numeric.name]: typeof r[numeric.name] === "number" ? 0 : (0).toFixed(numeric.decimals ?? 0) }))) });
    out.push({ name: "large values", input: render(records.map((r) => ({ ...r, [numeric.name]: typeof r[numeric.name] === "number" ? 123456.75 : (123456.75).toFixed(numeric.decimals ?? 0) }))) });
  }
  return out;
}

/** Invalid: a correct program refuses these, or at least does not silently invent data. */
export function malformedInputs(sample: string, repr: Repr, rng: Rng): NamedInput[] {
  if (repr.syntax.format === "binary") return [];
  if (!isRecordRepr(repr)) return [{ name: "random bytes as text", input: garbage(rng) }];
  const records = parseRecords(sample, repr.syntax);
  const names = repr.fields.map((f) => f.name);
  const render = (rs: Rec[]) => renderRecords(rs, repr.syntax, names);
  const out: NamedInput[] = [{ name: "not this format at all", input: garbage(rng) }, { name: "empty input", input: "" }];
  const full = render(records).trimEnd();
  // Cut the last record early enough that it has visibly lost fields.
  const lastLine = full.lastIndexOf("\n") + 1;
  const separator = repr.syntax.format === "delimited" ? full.indexOf(repr.syntax.delimiter, lastLine) : -1;
  out.push({ name: "truncated mid-record", input: full.slice(0, separator > 0 ? separator : lastLine + Math.floor((full.length - lastLine) / 2)) });
  const numeric = repr.fields.find((f) => f.kind === "decimal") ?? repr.fields.find((f) => f.kind === "int");
  if (numeric) out.push({ name: `non-numeric ${numeric.name}`, input: render(records.map((r, i) => (i === 0 ? { ...r, [numeric.name]: "n/a" } : r))) });
  const temporal = repr.fields.find((f) => f.kind === "datetime" || f.kind === "date");
  if (temporal) out.push({ name: `invalid ${temporal.name}`, input: render(records.map((r, i) => (i === 0 ? { ...r, [temporal.name]: "not-a-date" } : r))) });
  if (names.length > 1) out.push({ name: `column ${names[0]} missing`, input: renderRecords(records.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== names[0]))), repr.syntax, names.slice(1)) });
  return out;
}

function garbage(rng: Rng): string {
  return Array.from({ length: 6 }, () => rng.pick(["<<<", "%%%", "##", "~~", "}}{{"]).repeat(rng.int(1, 4))).join("\n");
}

/** Damage to a real input whose structure is not assumed. */
export function malformedText(sample: string, rng: Rng): NamedInput[] {
  return [{ name: "not this format at all", input: garbage(rng) }, { name: "empty input", input: "" }];
}

/** Binary corpus files with structural damage. */
export function malformedBinary(file: Buffer, rng: Rng): Array<{ name: string; input: Buffer }> {
  const cut = file.subarray(0, Math.floor(file.length * 0.6));
  const header = Buffer.from(file);
  for (let i = 0; i < Math.min(32, header.length); i++) header[i] = rng.int(0, 255);
  return [{ name: "truncated file", input: cut }, { name: "corrupted header", input: header }, { name: "empty file", input: Buffer.alloc(0) }];
}

/** Random permutation of records, keeping any header. */
export function permuteRecords(input: string, repr: Repr, rng: Rng): { input: string; order: number[] } | null {
  if (!isRecordRepr(repr)) return null;
  const records = parseRecords(input, repr.syntax);
  if (records.length < 3) return null;
  const order = rng.shuffle(records.map((_, i) => i));
  return { input: renderRecords(order.map((i) => records[i]), repr.syntax, repr.fields.map((f) => f.name)), order };
}

