import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { sha256 } from "../packages/shared/index.ts";
import { RightClick } from "../packages/rcx-adapter/index.ts";

const root = path.join(import.meta.dirname, "../vendor/rightclick-x");

test("every vendored RightClick X file is byte-identical to the recorded upstream commit", () => {
  const upstream = JSON.parse(fs.readFileSync(path.join(root, "UPSTREAM.json"), "utf8"));
  assert.equal(upstream.commit, "278d66c327ffe60b25805399b1f6d284840d1628");
  assert.deepEqual(upstream.modified, []);
  assert.ok(Object.keys(upstream.files).length > 50);
  for (const [file, hash] of Object.entries(upstream.files)) assert.equal(sha256(fs.readFileSync(path.join(root, file))), hash, file);
});

test("the one private seam EXAPT relies on still exists", async () => {
  const rc = await RightClick.create({ sandbox: null });
  assert.ok((rc as unknown as { builtins: unknown }).builtins instanceof Map);
});

test("the Apache licence travels with the vendored code", () => {
  assert.match(fs.readFileSync(path.join(root, "LICENSE"), "utf8"), /Apache License/);
  assert.match(fs.readFileSync(path.join(root, "../../NOTICE"), "utf8"), /RightClick X/);
});
