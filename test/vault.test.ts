import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { Vault, type CapabilityManifest } from "../packages/capability-memory/index.ts";
import { sha256 } from "../packages/shared/index.ts";
import { tempDir } from "./support.ts";

function manifest(vault: Vault, id: string, version: number, source = "export function transform(i) { return i; }"): CapabilityManifest {
  const artefact = vault.put(source);
  return {
    format: "exapt/capability@1", id, version, status: "verified-within-scope", title: "t", purpose: "p",
    inputs: [{ name: "input", representation: "a", semantic: "text" }], outputs: [{ name: "output", representation: "b", semantic: "text" }],
    artefact: { sha256: artefact, language: "javascript-esm", entry: "transform", bytes: source.length },
    contract: {} as never, dependencies: [], environment: { runtime: "node 22", image: "x", backend: "docker" }, permissions: { network: false, filesystem: "none", risk: "read" },
    evidence: { level: "verified-in-domain" } as never, limitations: [], counterexamples: [], rejected: [],
    provenance: { goal: "g", run: "r", producer: "p", kind: "enumerative", real: false, createdAt: "now" }, revalidation: { suite: vault.put('{"cases":[]}'), witnesses: [], instructions: "" }, receipts: [],
  };
}

test("objects are content-addressed and tampering is detected on read", () => {
  const v = new Vault(tempDir("vault"));
  const hash = v.put("hello");
  assert.equal(hash, sha256("hello"));
  fs.writeFileSync(path.join(v.root, "objects", hash), "tampered");
  assert.throws(() => v.get(hash), /does not match its address/);
});

test("promotion is versioned and the earlier version remains on record", () => {
  const v = new Vault(tempDir("vault"));
  v.retain(manifest(v, "exapt:thing", 1));
  v.retain(manifest(v, "exapt:thing", 2, "export function transform(i) { return i + 1; }"));
  const s = v.state("exapt:thing")!;
  assert.equal(s.current, 2);
  assert.equal(s.versions.find((x) => x.version === 1)!.status, "refused");
  assert.match(s.versions.find((x) => x.version === 1)!.reason!, /superseded/);
  assert.ok(v.manifest("exapt:thing", 1));
});

test("a version pin holds against later promotion, and revocation refuses every version", () => {
  const v = new Vault(tempDir("vault"));
  v.retain(manifest(v, "exapt:thing", 1));
  v.pin("exapt:thing", 1);
  v.retain(manifest(v, "exapt:thing", 2, "export function transform(i) { return 2; }"));
  assert.equal(v.manifest("exapt:thing")!.version, 1);
  v.revoke("exapt:thing", "operator decision");
  assert.equal(v.manifest("exapt:thing", 2)!.status, "refused");
  assert.equal(v.manifest("exapt:thing", 1)!.status, "refused");
});

test("ids cannot escape the vault", () => {
  const v = new Vault(tempDir("vault"));
  assert.throws(() => v.state("exapt:../../etc/passwd"), /invalid capability id/);
});

test("a bundle carries no receipts, and an imported definition starts unverified", () => {
  const a = new Vault(tempDir("vault"));
  a.retain({ ...manifest(a, "exapt:thing", 1), receipts: ["secret-looking-receipt"] });
  const bundle = a.exportBundle("exapt:thing");
  assert.deepEqual(bundle.manifest.receipts, []);
  const b = new Vault(tempDir("vault"));
  const m = b.importBundle(bundle);
  assert.equal(m.status, "synthesised-unverified");
  assert.ok(m.provenance.importedFrom);
});

test("a bundle whose source does not match its digest is refused", () => {
  const a = new Vault(tempDir("vault"));
  a.retain(manifest(a, "exapt:thing", 1));
  const bundle = { ...a.exportBundle("exapt:thing"), source: "export function transform() { return 'evil'; }" };
  assert.throws(() => new Vault(tempDir("vault")).importBundle(bundle), /does not match/);
});
