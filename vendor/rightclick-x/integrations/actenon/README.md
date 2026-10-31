# Optional Actenon historical evidence

This Node host adapter connects an operator-owned Actenon attestation file to the
existing RightClick X dashboard. It verifies historical resource decisions. It
does **not** install a protected execution boundary, authorize an action, broker
credentials, grant current permission or verify the business outcome.

Provision Actenon separately. The tested source profile is Kernel
`da4b534bbee1850b18ce6ffc5d3dccba0c3a5dcf` and Permit
`5290b1304eead3e638c5a4aa1600fa63ba3137e8`, with Python 3.12, Ed25519 public JWKs
and native `v2alpha1` receipt/refusal attestations. The adapter imports their
existing verifier. Other versions are untested; unknown versions and keys fail
closed. No dependency is downloaded or added to the core runtime.

```ts
import { RightClick, createHandler } from "rightclick-x";
import { actenonAuthorityEvidence } from "rightclick-x/actenon-evidence";

const runtime = await RightClick.create(/* your existing operator configuration */);
const handler = createHandler(runtime, {
  token: process.env.RCX_TOKEN, // existing API authentication
  authorityEvidence: actenonAuthorityEvidence({
    python: "/absolute/operator-owned/venv/bin/python",
    attestations: "/absolute/protected-resource/attestations.jsonl",
    publicKey: "/absolute/operator-owned/resource-public.json",
    origin: "https://resource.example",
    issuer: "resource-edge",
    boundary: "Operator-named resource",
  }),
});
// Serve handler through your existing HTTP host.
```

The public key's exact bytes are pinned when the adapter is constructed. Rotate
the trust anchor by restarting/reconfiguring the trusted host, not by replacing
the file behind a running reader. Keep that key/configuration outside the agent's
writable surface. The resource must sign its decisions independently; accepting
an agent-supplied key would establish nothing.

Authenticated `GET /api/authority-evidence` returns at most 100 projected records
from at most 4 MiB of input. The native subprocess has a 2.5-second timeout and
256 KiB output bound. Raw bodies, target URLs, proofs, credentials and credential
references are excluded. Missing, incomplete, duplicate, unverified or out-of-
boundary records make the feed unavailable. Empty evidence is not proof of no
activity. Standalone signatures do not prove journal completeness, ordering or
that the signed resource's claims are true.

The generic host reader accepts no model/tool setter, retains no evidence in
capability knowledge, and does not alter dispatch. Historical records remain
unlinked to runtime calls unless a separate trustworthy correlation exists.
Current-authority metrics remain unknown. This optional adapter is included in
the local package; it is not an independent security certification or a complete
Actenon production installation.

The optional `transportLinks` absolute path enables **operator correlation**.
The operator's transport receives an optional third `FetchLike` argument:
`{ runtimeId, runId, capabilityId, requestId }`. It is local observation context,
not an HTTP header, credential or permission. Each actual fetch gets a new
request ID; redirects and asynchronous monitors retain their owning leaf run.
Contract discovery has no owning execution. Existing two-argument transports
continue to work.

The tested HTTP resource responds with `x-actenon-artifacts`, a JSON array of
`{ artifactDigest, nativeRequestId }` references from its native attestations.
This response header alone is untrusted. A trusted operator transport journals
one JSONL record per response:

```json
{
  "version": 1,
  "context": { "runtimeId": "UUID", "runId": "run_…", "capabilityId": "…", "requestId": "UUID" },
  "wire": { "method": "POST", "url": "https://resource.example/path", "headers": {}, "body": "BASE64" },
  "artifacts": [{ "artifactDigest": "64_LOWERCASE_HEX_DIGITS", "nativeRequestId": "req_gate_…" }]
}
```

This is a bounded HTTP development profile: native action `http.<method>`,
target type `tool`, and exact method/semantic headers/base64 body in the signed
action. The adapter imports Actenon's verifier and checks those fields and the
native gate request ID. It rejects duplicates and ambiguous mappings. Up to
1,000 transport records and 4 MiB are accepted; operators must manage a coherent
bounded log. Missing/partial/oversized configured logs fail closed.

The association between context and response relies on the operator-owned log
and uncompromised runtime/transport. Native signatures authenticate the action,
not RightClick's identity. Proof IDs, timestamps and identical bodies cannot
substitute for a native response attempt reference. Lost responses remain
unlinked. The dashboard projects a link only while a matching current-epoch
execution observation is retained; restart or eviction removes the link.
Raw requests, proofs and credentials remain excluded from that feed and from
capability knowledge. Protect the transport log from agent writes and treat its
raw request data according to the resource's confidentiality requirements.
