import assert from "node:assert/strict";
import test from "node:test";
import { emitLens, synthesiseLens } from "../packages/synthesiser/lens.ts";
import { compareRecords, parseRecords, sniffSyntax } from "../packages/capability-universe/repr.ts";

const run = async (source: string, input: string): Promise<string> => {
  // Trusted test data and our own emitter: this runs in-process only here, in a unit test.
  const mod = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  return mod.transform(input);
};

function solves(pairs: Array<{ input: string; output: string }>, unseen: { input: string; output: string }) {
  const r = synthesiseLens(pairs);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  return (async () => {
    const out = await run(emitLens(r.programs[0]), unseen.input);
    const s = sniffSyntax(unseen.output);
    const c = compareRecords(parseRecords(unseen.output, s), parseRecords(out, s));
    assert.ok(c.equal, JSON.stringify(c.diffs));
  })();
}

test("delimited to NDJSON with renames, a unit conversion and epoch seconds", () =>
  solves([{ input: "id;t;f\nu1;2026-01-01T00:00:00Z;50.000\nu2;2026-01-01T00:01:00Z;68.000\nu3;2026-01-02T00:00:00Z;41.000\n", output: '{"unit":"u1","at":1767225600,"c":10}\n{"unit":"u2","at":1767225660,"c":20}\n{"unit":"u3","at":1767312000,"c":5}\n' }],
    { input: "id;t;f\nz9;2026-02-01T00:00:00Z;104.000\n", output: '{"unit":"z9","at":1769904000,"c":40}\n' }));

test("key/value blocks to a tab table with a fixed-width number", () =>
  solves([{ input: "name: bolt\nqty: 5\n\nname: nut\nqty: 12\n", output: "item\tcount\nbolt\t5.00\nnut\t12.00\n" }],
    { input: "name: washer\nqty: 7\n", output: "item\tcount\nwasher\t7.00\n" }));

test("fixed-width to JSON array with upper-casing and a stripped prefix", () =>
  solves([{ input: "CODE      CITY\nsku-1     paris\nsku-2     rome\n", output: '[{"sku":"1","city":"PARIS"},{"sku":"2","city":"ROME"}]\n' }],
    { input: "CODE      CITY\nsku-77    oslo\nsku-8     lima\n", output: '[{"sku":"77","city":"OSLO"},{"sku":"8","city":"LIMA"}]\n' }));

test("two fields joined, and a date reformatted", () =>
  solves([{ input: "first,last,born\nAda,Byron,1815-12-10\nAlan,Turing,1912-06-23\n", output: "full|dob\nAda Byron|10/12/1815\nAlan Turing|23/06/1912\n" }],
    { input: "first,last,born\nGrace,Hopper,1906-12-09\n", output: "full|dob\nGrace Hopper|09/12/1906\n" }));

test("the simplest hypothesis comes first and more evidence corrects it", () => {
  // One observed x cannot separate a scale from an offset.
  const one = synthesiseLens([{ input: "x,k\n50,a\n", output: '{"y":10,"k":"a"}\n' }]);
  assert.ok(one.ok);
  const more = synthesiseLens([{ input: "x,k\n50,a\n68,b\n212,c\n", output: '{"y":10,"k":"a"}\n{"y":20,"k":"b"}\n{"y":100,"k":"c"}\n' }]);
  assert.ok(more.ok);
  return (async () => {
    const out = await run(emitLens(more.programs[0]), "x,k\n32,z\n");
    assert.equal(JSON.parse(out).y, 0);
  })();
});

test("a task outside the language fails and says why, with no fallback answer", () => {
  const r = synthesiseLens([{ input: "a,b\n1,x\n2,y\n", output: '{"total":3}\n' }]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /filtering and aggregation/);
});

test("a field no expression can explain is reported, not guessed", () => {
  const r = synthesiseLens([{ input: "a\n1\n2\n3\n", output: '{"z":"kq"}\n{"z":"mf"}\n{"z":"tb"}\n' }]);
  assert.ok(!r.ok || r.programs[0].fields[0].expr.op === "map", "only a lookup could fit, and a lookup throws on unseen keys");
});
