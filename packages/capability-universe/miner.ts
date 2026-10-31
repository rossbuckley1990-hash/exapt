// The contract miner: experiments that establish what a program really reads and writes.
//
// RightClick X's investigator tries generic synthetic inputs, which is right for general utilities
// and exactly wrong for a program with a strict input format: all twenty trials fail, and the
// program stays a declared text-to-text interface. Planning on that would treat every program as
// able to feed every other. The miner starts instead from a positive sample (from the program's
// documentation, or from what another program produced), confirms it by running it, and then
// perturbs it. Each conclusion in a ToolContract is an observation in the sandbox, never a guess
// from prose. Nothing here knows any particular program.
import { digest, Rng } from "../shared/index.ts";
import { cellText, isRecordRepr, parseRecords, renderRecords, sniff, type Rec, type Repr } from "./repr.ts";
import { emptyContract, type Claim, type ToolContract } from "./types.ts";

type Run = (input: string, opts?: { args?: string[] }) => Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }>;
export interface DocOption { flags: string[]; arg?: string; optionalArg?: string; description: string }

export const accepted = (r: { ok: boolean; stdout: string; stderr?: string }): boolean =>
  r.ok && r.stdout.trim() !== "" && !/^\s*(error|fatal|invalid)\b/i.test(r.stdout);

const HEADING = /^\s*(examples?|samples?|input|inputs?\s+format|format|e\.g\.)\b[^\n]*:?\s*$/i;
const indentOf = (l: string): number => /^\s*/.exec(l)![0].length;

/** Blocks of indented literal data in documentation, likeliest first. */
export function docSamples(docs: string): string[] {
  const ls = docs.split("\n");
  const blocks: Array<{ text: string; rank: number }> = [];
  let i = 0;
  while (i < ls.length) {
    if (indentOf(ls[i]) < 2 || !ls[i].trim()) {
      i++;
      continue;
    }
    const start = i;
    const indent = indentOf(ls[i]);
    const body: string[] = [];
    while (i < ls.length && (ls[i].trim() === "" ? i + 1 < ls.length && indentOf(ls[i + 1]) >= indent && ls[i + 1].trim() !== "" : indentOf(ls[i]) >= indent)) {
      body.push(ls[i].slice(indent));
      i++;
    }
    const text = body.filter((l) => !/^\$ /.test(l)).join("\n").trim();
    if (!text || /^-{1,2}\w/.test(text)) continue;
    let h = start - 1;
    while (h >= 0 && !ls[h].trim()) h--;
    const heading = h >= 0 ? ls[h] : "";
    const output = /output/i.test(heading);
    blocks.push({ text: `${text}\n`, rank: output ? 2 : HEADING.test(heading) || /example|sample|input|format/i.test(heading) ? 0 : 1 });
  }
  return blocks.sort((a, b) => a.rank - b.rank).map((b) => b.text).slice(0, 16);
}

/** Value lists a documented option names: "{a,b}", "one of: a, b", "a|b". */
export function optionValues(description: string, arg?: string): string[] {
  const out = new Set<string>();
  const add = (s: string) => {
    const t = s.trim().replace(/^["'`]|["'`.,;)]+$/g, "");
    if (/^[A-Za-z0-9][\w.-]{0,24}$/.test(t)) out.add(t);
  };
  const metavar = /^<?\{?([\w.-]+(?:[|,][\w.-]+)+)\}?>?$/.exec(arg ?? "");
  if (metavar) metavar[1].split(/[|,]/).forEach(add);
  const list = /(?:one of|formats?|values?|either|choices?|supported)[:\s]+([^\n]+)/i.exec(description);
  if (list) list[1].split(/[,|/]|\s+or\s+/).forEach(add);
  return [...out].slice(0, 8);
}

function withoutField(records: Rec[], field: string): Rec[] {
  return records.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => k !== field)));
}

function withValue(records: Rec[], field: string, value: (v: unknown) => string | number): Rec[] {
  return records.map((r) => ({ ...r, [field]: value(r[field]) }));
}

/** Mine one program. `seeds` are bytes known to exist in this environment, tried after the docs. */
export async function mineContract(tool: string, name: string, docs: string, run: Run, opts: { seeds?: string[]; options?: DocOption[] } = {}): Promise<ToolContract> {
  const c = emptyContract(tool, name, docs);
  const claims: Claim[] = [];
  let probes = 0;
  const attempt: Run = async (input, o) => {
    probes++;
    return run(input, o);
  };
  const candidates = [...docSamples(docs), ...(opts.seeds ?? [])];
  const positive: string[] = [];
  const outputs: string[] = [];
  for (const sample of candidates) {
    if (positive.length >= 4) break;
    const r = await attempt(sample);
    if (accepted(r)) {
      positive.push(sample);
      outputs.push(r.stdout);
    }
  }
  if (!positive.length) {
    claims.push({ claim: "no accepted input observed", status: "unknown", detail: `${candidates.length} candidate sample(s) tried` });
    c.claims = claims;
    c.probes = probes;
    return c;
  }
  claims.push({ claim: `accepts ${positive.length} confirmed sample(s)`, status: "observed", detail: "ran in the program sandbox" });
  const primary = positive[0];
  const repr: Repr = sniff(primary);
  const rejected: Array<{ variant: string; error: string }> = [];
  const required: string[] = [];
  const optional: string[] = [];
  const influential: string[] = [];
  if (isRecordRepr(repr)) {
    const records = parseRecords(primary, repr.syntax);
    const names = repr.fields.map((f) => f.name);
    const render = (rs: Rec[], cols = names) => renderRecords(rs, repr.syntax, cols);
    const base = outputs[0];
    for (const field of names) {
      const r = await attempt(render(withoutField(records, field), names.filter((n) => n !== field)));
      if (accepted(r)) optional.push(field);
      else {
        required.push(field);
        if (rejected.length < 8) rejected.push({ variant: `without ${field}`, error: (r.stderr || r.stdout).trim().slice(0, 160) });
      }
      const original = records[0]?.[field];
      const changed = typeof original === "number" || /^-?\d/.test(cellText(original))
        ? withValue(records, field, (v) => (Number(v) || 0) + 1)
        : withValue(records, field, (v) => `${cellText(v as string)}x`);
      const moved = await attempt(render(changed));
      if (accepted(moved) && moved.stdout !== base) influential.push(field);
      else if (!accepted(moved) && rejected.length < 8) rejected.push({ variant: `${field} perturbed`, error: (moved.stderr || moved.stdout).trim().slice(0, 160) });
    }
    if (required.length) claims.push({ claim: `requires fields ${required.join(", ")}`, status: "experimentally-supported", detail: "removing each one made the program refuse" });
    if (influential.length) claims.push({ claim: `output depends on ${influential.join(", ")}`, status: "experimentally-supported", detail: "perturbing each one changed the output" });
    const rng = new Rng(7);
    const nonsense = await attempt(rng.shuffle(primary.split("")).join(""));
    claims.push({ claim: accepted(nonsense) ? "accepts scrambled bytes" : "refuses scrambled bytes", status: "observed", detail: "the acceptance of this program says " + (accepted(nonsense) ? "little" : "something") + " about well-formedness" });
  }
  for (const o of opts.options ?? []) {
    const values = optionValues(o.description, o.arg ?? o.optionalArg);
    if (values.length) c.options.push({ flags: o.flags, values, description: o.description.slice(0, 200) });
  }
  const outputRepr = sniff(outputs[0]);
  c.input = { repr, requiredFields: required, optionalFields: optional, influentialFields: influential, positive, rejected };
  c.output = { repr: outputRepr, example: outputs[0].slice(0, 2000) };
  c.behaviour = digest({ tool: name, outputs });
  c.claims = claims;
  c.probes = probes;
  return c;
}
