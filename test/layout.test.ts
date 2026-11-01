import assert from "node:assert/strict";
import test from "node:test";
import { induceLayout } from "../packages/synthesiser/layout.ts";

/** A self-describing binary table in a format invented for this test: not dBase, and laid out
 *  differently, so an inducer that had dBase built in would fail. */
function makeFile(fields: Array<[string, number]>, rows: string[][]): Buffer {
  const entry = 24;
  const lead = 2;
  const recordSize = lead + fields.reduce((n, [, w]) => n + w, 0);
  const headerSize = 16 + fields.length * entry + 3;
  const b = Buffer.alloc(headerSize + rows.length * recordSize, 0);
  b.write("ZTBL", 0, "latin1");
  b.writeUInt16BE(0x0102, 4);
  b.writeUInt32LE(rows.length, 6);
  b.writeUInt16LE(headerSize, 10);
  b.writeUInt16LE(recordSize, 12);
  fields.forEach(([name, width], i) => {
    const at = 16 + i * entry;
    b.write(name, at, "latin1");
    b[at + 20] = width;
  });
  rows.forEach((row, r) => {
    const at = headerSize + r * recordSize;
    b.write("ok", at, "latin1");
    let off = lead;
    fields.forEach(([, width], i) => {
      b.write(row[i].padEnd(width, " "), at + off, "latin1");
      off += width;
    });
  });
  return b;
}

const ndjson = (fields: Array<[string, number]>, rows: string[][]) => rows.map((r) => JSON.stringify(Object.fromEntries(fields.map(([n], i) => [n, r[i]])))).join("\n") + "\n";
const pair = (fields: Array<[string, number]>, rows: string[][]) => ({ input: makeFile(fields, rows).toString("base64"), output: ndjson(fields, rows), binary: true });

const A: Array<[string, number]> = [["city", 12], ["code", 6], ["region", 10]];
const B: Array<[string, number]> = [["part", 9], ["bin", 5]];
const rowsA = [["Paris", "FR75", "North"], ["Lyon", "FR69", "South"], ["Nantes", "FR44", "West"], ["Lille", "FR59", "Far North"]];
const rowsB = [["bolt-m3", "A1"], ["nut-m4", "B7"], ["washer", "C2"]];

test("induction reads a self-describing format it has never seen, across schemas", async () => {
  const r = induceLayout([pair(A, rowsA), pair(B, rowsB)]);
  assert.ok(r.ok, r.ok ? "" : r.reason);
  const described = r.programs.find((p) => p.explanation.some((e) => e.includes("field table")));
  assert.ok(described, JSON.stringify(r.programs.map((p) => p.explanation)));
  const mod = await import(`data:text/javascript,${encodeURIComponent(described.source)}`);
  const C: Array<[string, number]> = [["alpha", 7], ["beta", 11], ["gamma", 4], ["delta", 3]];
  const rowsC = [["one", "two words", "x", "ab"], ["three", "four", "y", "cd"]];
  assert.equal(mod.transform(makeFile(C, rowsC)), ndjson(C, rowsC));
});

test("the emitted reader refuses a truncated file instead of inventing records", async () => {
  const r = induceLayout([pair(A, rowsA), pair(B, rowsB)]);
  assert.ok(r.ok);
  const mod = await import(`data:text/javascript,${encodeURIComponent(r.programs[0].source)}`);
  const file = makeFile(A, rowsA);
  assert.throws(() => mod.transform(file.subarray(0, file.length - 20)));
});

test("bytes with no record structure fail honestly", () => {
  const r = induceLayout([{ input: Buffer.from("no structure here at all, just prose and nothing fixed").toString("base64"), output: '{"a":"qqq"}\n{"a":"zzz"}\n', binary: true }]);
  assert.equal(r.ok, false);
});
