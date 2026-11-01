import assert from "node:assert/strict";
import test from "node:test";
import { codePositions, mutantsOf } from "../packages/experiment-engine/index.ts";

test("only code can be mutated: comments, strings, templates and regexes cannot", () => {
  const source = `// C = (F - 32) * 5 / 9\nconst s = "1 + 2";\nconst t = \`3 * 4\`;\nconst r = /5 + 6/;\nconst v = 7 * 8;\n`;
  const code = codePositions(source);
  assert.equal(code[source.indexOf("32")], false);
  assert.equal(code[source.indexOf("1 + 2")], false);
  assert.equal(code[source.indexOf("3 * 4")], false);
  assert.equal(code[source.indexOf("5 + 6")], false);
  assert.equal(code[source.indexOf("7 * 8")], true);
  for (const m of mutantsOf(source)) assert.ok(m.source.includes("// C = (F - 32) * 5 / 9"), m.name);
});

test("division is not read as a regular expression", () => {
  const source = "const a = b / c + d / e;\n";
  assert.ok(codePositions(source).slice(0, source.length - 1).every(Boolean));
});

test("value faults are sampled first and an altered error message is not a fault", () => {
  const source = `export function transform(x) {\n  if (!x) throw new Error("line " + (1 + 2));\n  return String(Number(x) * 100 + 5);\n}\n`;
  const mutants = mutantsOf(source);
  assert.ok(mutants.some((m) => m.kind === "value"));
  for (const m of mutants) assert.ok(m.source.includes('"line " + (1 + 2)') || m.kind === "robustness", m.name);
});

test("the same program always faces the same faults, so a verdict cannot be improved by retrying", () => {
  const source = "export function transform(x) {\n  const a = Number(x) * 100 + 5;\n  const b = a / 3 - 1;\n  return String(b * 2 + a);\n}\n";
  assert.deepEqual(mutantsOf(source).map((m) => m.name), mutantsOf(source).map((m) => m.name));
  assert.ok(mutantsOf(source).length >= 5);
});
