// Optional Node host adapter. Actenon's installed Python verifier is a separately
// provisioned dependency; the core package has no dependency on it.
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { isAbsolute } from "node:path";
import type { AuthorityEvidenceSource } from "../../src/interface/authority-evidence.ts";

export function actenonAuthorityEvidence(config: {
  python: string; attestations: string; publicKey: string; origin: string; issuer: string; boundary: string;
  /** Optional operator-owned response association log; not signed runtime identity. */
  transportLinks?: string;
}): AuthorityEvidenceSource {
  if (![config.python, config.attestations, config.publicKey, ...(config.transportLinks ? [config.transportLinks] : [])].every(isAbsolute)) throw new Error("absolute operator-owned paths required");
  const key = readFileSync(config.publicKey);
  if (key.length > 4096) throw new Error("public verification key exceeds profile");
  const trustAnchor = createHash("sha256").update(key).digest("hex");
  return { name: "Actenon native attestation verifier", boundary: config.boundary, trustAnchor, timeoutMs: 3000,
    read: signal => new Promise((resolve, reject) => {
      execFile(config.python, ["-B", fileURLToPath(new URL("./authority-evidence.py", import.meta.url)),
        "--attestations", config.attestations, "--public-key", config.publicKey, "--trust-anchor", trustAnchor,
        "--origin", config.origin, "--issuer", config.issuer,
        ...(config.transportLinks ? ["--transport-links", config.transportLinks] : [])],
      { signal, timeout: 2500, maxBuffer: 256 * 1024, encoding: "utf8",
        env: { PATH: process.env.PATH, PYTHONDONTWRITEBYTECODE: "1" } }, (error, stdout) => {
        if (error) { reject(new Error("native authority evidence unavailable")); return; }
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("invalid native evidence response")); }
      });
    }) };
}
