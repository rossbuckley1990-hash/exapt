import assert from "node:assert/strict";
import test from "node:test";
import { accepted, docSamples, mineContract, optionValues } from "../packages/capability-universe/index.ts";

const strictConsumer = async (input: string) => {
  const rows = input.trim().split("\n").filter(Boolean);
  try {
    let sum = 0;
    for (const r of rows) {
      const o = JSON.parse(r);
      if (typeof o.who !== "string" || typeof o.n !== "number") throw new Error("missing who or n");
      sum += o.n;
    }
    return { ok: rows.length > 0, stdout: rows.length ? `total ${sum}\n` : "", stderr: "", code: rows.length ? 0 : 3 };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e), code: 3 };
  }
};

test("documentation yields candidate samples, example blocks first", () => {
  const samples = docSamples("usage: tool\n\nOptions:\n  --flag   does a thing\n\nExample input:\n  {\"a\":1}\n  {\"a\":2}\n\nExample output:\n  total 3\n");
  assert.equal(samples[0], '{"a":1}\n{"a":2}\n');
  assert.ok(!samples.some((s) => s.startsWith("--")));
});

test("what a program requires is established by removing it", async () => {
  const c = await mineContract("t", "t", 'usage: t\n\nExample input:\n  {"who":"a","n":1,"note":"x"}\n  {"who":"b","n":2,"note":"y"}\n', strictConsumer);
  assert.ok(c.input);
  assert.deepEqual(c.input.requiredFields.sort(), ["n", "who"]);
  assert.deepEqual(c.input.optionalFields, ["note"]);
  assert.ok(c.input.influentialFields.includes("n"));
  assert.ok(!c.input.influentialFields.includes("note"));
  assert.ok(c.behaviour);
});

test("whole numbers in every sample do not make a field integral: the program is asked", async () => {
  const c = await mineContract("t", "t", 'Example input:\n  {"who":"a","n":1}\n', strictConsumer);
  assert.equal(c.input!.repr.fields.find((f) => f.name === "n")!.kind, "decimal");
});

test("a field the program really keeps integral stays integral", async () => {
  const integral = async (input: string) => {
    try {
      if (Number.isInteger(JSON.parse(input.trim()).n)) return { ok: true, stdout: "ok\n", stderr: "", code: 0 };
    } catch {
      /* refused below */
    }
    return { ok: false, stdout: "", stderr: "n must be an integer", code: 3 };
  };
  const c = await mineContract("t", "t", 'Example input:\n  {"who":"a","n":1}\n', integral);
  assert.equal(c.input!.repr.fields.find((f) => f.name === "n")!.kind, "int");
});

test("a program no sample satisfies stays unestablished", async () => {
  const c = await mineContract("t", "t", "no examples here", async () => ({ ok: false, stdout: "", stderr: "no", code: 1 }));
  assert.equal(c.input, null);
  assert.equal(c.claims[0].status, "unknown");
});

test("empty output and error text on stdout are not acceptance", () => {
  assert.equal(accepted({ ok: true, stdout: "  ", stderr: "" }), false);
  assert.equal(accepted({ ok: true, stdout: "error: nope", stderr: "" }), false);
  assert.equal(accepted({ ok: true, stdout: "fine", stderr: "" }), true);
});

test("documented option values are read from common notations", () => {
  assert.deepEqual(optionValues("input format, one of: csv, json", "FORMAT"), ["csv", "json"]);
  assert.deepEqual(optionValues("", "{csv,json}"), ["csv", "json"]);
});

test("a program with prose-only documentation can still be learned from suggested samples", async () => {
  const c = await mineContract("t", "t", "Reads JSON lines with who and n.", strictConsumer, { seeds: ['{"who":"a","n":1}\n{"who":"b","n":2}\n', "wrong guess\n"] });
  assert.ok(c.input, "the program accepted one suggestion");
  assert.equal(c.input!.positive.length, 1, "and only what it accepted counts");
});
