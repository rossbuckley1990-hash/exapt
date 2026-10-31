// Deliberately wrong programs, used as negative controls. Each is plausible, runs, and produces
// output the consumer accepts or nearly accepts. The gates must reject every one of them.
import { makeCandidate, type Candidate } from "../../packages/synthesiser/index.ts";
import type { Params } from "./environment.ts";

function adapter(p: Params, mapping: { id: string; time: string; value: string; note: string }, tail = ""): string {
  const d = JSON.stringify(p.delimiter);
  return `export function transform(input) {
  const lines = input.trim().split(/\\r?\\n/);
  const header = lines[0].split(${d});
  const out = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(${d});
    const r = Object.fromEntries(header.map((h, i) => [h, cells[i]]));
    const num = (x) => { const n = Number(x); if (!Number.isFinite(n)) throw new Error("bad number"); return n; };
    out.push({ ${JSON.stringify(p.target.id)}: ${mapping.id}, ${JSON.stringify(p.target.time)}: ${mapping.time}, ${JSON.stringify(p.target.value)}: ${mapping.value}, ${JSON.stringify(p.target.note)}: ${mapping.note} });
  }
  ${tail}
  return out.map((o) => JSON.stringify(o)).join("\\n") + "\\n";
}
`;
}

export function negativeControls(p: Params): Array<{ name: string; candidate: Candidate; fault: string }> {
  const { source: s, conversion: c } = p;
  const get = (k: string) => `r[${JSON.stringify(k)}]`;
  const id = p.idTransform === "strip-prefix" ? `${get(s.id)}.replace(/^rig-/, "")` : get(s.id);
  const time = `Date.parse(${get(s.time)}) / 1000`;
  const value = `Number((num(${get(s.value)}) * ${c.a} + ${c.b}).toFixed(${c.places}))`;
  const note = get(s.note);
  const good = { id, time, value, note };
  const control = (name: string, fault: string, source: string) => ({ name, fault, candidate: makeCandidate(source, "injected-control", 0, `negative control: ${name}`, [fault]) });
  return [
    control("unconverted-unit", `copies the value in ${c.sourceUnit} into a field defined in ${c.targetUnit}; the consumer cannot tell`, adapter(p, { ...good, value: `num(${get(s.value)})` })),
    control("swapped-fields", "writes the identifier into the location and the location into the identifier; both are strings, so the consumer accepts it", adapter(p, { ...good, id: note, note: id })),
    control("lost-last-record", "silently drops the final record", adapter(p, good, "out.pop();")),
    control("wrong-rounding", "truncates the value to whole numbers", adapter(p, { ...good, value: `Math.trunc(num(${get(s.value)}) * ${c.a} + ${c.b})` })),
  ];
}
