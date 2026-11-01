import assert from "node:assert/strict";
import test from "node:test";
import { compareRecords, fieldCoverage, kindOf, parseRecords, renderRecords, reprFits, reprLabel, sameSyntax, sniff, sniffSyntax } from "../packages/capability-universe/repr.ts";

test("sniffing tells record syntaxes apart from real bytes", () => {
  assert.deepEqual(sniffSyntax("a;b;c\n1;2;3\n4;5;6\n"), { format: "delimited", delimiter: ";", header: true });
  assert.deepEqual(sniffSyntax("a\tb\n1\t2\n"), { format: "delimited", delimiter: "\t", header: true });
  assert.equal(sniffSyntax('{"a":1}\n{"a":2}\n').format, "ndjson");
  assert.equal(sniffSyntax('[{"a":1},{"a":2}]').format, "json-array");
  assert.deepEqual(sniffSyntax('{"rows":[{"a":1}],"total":1}'), { format: "json-document", recordsKey: "rows" });
  assert.equal(sniffSyntax("id: 1\nname: x\n\nid: 2\nname: y\n").format, "kv-blocks");
  assert.equal(sniffSyntax("level=info msg=hello\nlevel=warn msg=bye\n").format, "logfmt");
  assert.equal(sniffSyntax("ID   NAME   QTY\n1    bolt   10\n2    nut    20\n").format, "fixed-width");
  assert.equal(sniffSyntax("a sentence with no structure at all").format, "text");
  assert.equal(sniffSyntax(Buffer.from([3, 0, 1, 2, 0, 0, 255])).format, "binary");
});

test("quoted cells survive a parse and render round trip", () => {
  const syntax = sniffSyntax('a,b\n"x,1","say ""hi"""\n');
  const records = parseRecords('a,b\n"x,1","say ""hi"""\n', syntax);
  assert.deepEqual(records, [{ a: "x,1", b: 'say "hi"' }]);
  assert.deepEqual(parseRecords(renderRecords(records, syntax, ["a", "b"]), syntax), records);
});

for (const text of ["a|b\n1|2\n", '{"a":1,"b":"x"}\n', '[{"a":1}]\n', "a: 1\nb: 2\n\na: 3\nb: 4\n", "x=1 y=2\nx=3 y=4\n"]) {
  test(`records render back to the same syntax: ${JSON.stringify(text).slice(0, 24)}`, () => {
    const s = sniffSyntax(text);
    const r = parseRecords(text, s);
    assert.deepEqual(parseRecords(renderRecords(r, s), s), r);
  });
}

test("field kinds are read from values, and identifiers with leading zeros stay strings", () => {
  assert.equal(kindOf("12"), "int");
  assert.equal(kindOf("12.5"), "decimal");
  assert.equal(kindOf("007"), "string");
  assert.equal(kindOf("2026-03-01"), "date");
  assert.equal(kindOf("2026-03-01T10:00:00Z"), "datetime");
});

test("a type match is not a representation match", () => {
  const a = sniff("x;y\n1;2\n");
  const b = sniff("x,y\n1,2\n");
  assert.equal(sameSyntax(a.syntax, b.syntax), false);
  assert.equal(reprFits(a, b), false);
  assert.notEqual(reprLabel(a), reprLabel(b));
  assert.equal(fieldCoverage(a, b), 1);
});

test("comparison allows one unit in the stated last place and no more", () => {
  assert.equal(compareRecords([{ a: 1.25 }], [{ a: 1.25 }]).equal, true);
  assert.equal(compareRecords([{ a: 1.25 }], [{ a: 1.26 }]).equal, true);
  assert.equal(compareRecords([{ a: 1.25 }], [{ a: 1.27 }]).equal, false);
  assert.equal(compareRecords([{ a: "x" }], [{ a: "y" }]).equal, false);
  assert.equal(compareRecords([{ a: "1" }], [{ a: 1 }, { a: 2 }]).equal, false);
});
