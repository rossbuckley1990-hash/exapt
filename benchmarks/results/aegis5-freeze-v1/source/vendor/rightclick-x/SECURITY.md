# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities **privately**, via GitHub's private vulnerability reporting for this repository (Security → Report a vulnerability). Do not open a public issue.

Include:

- what you did;
- what happened;
- what you expected;
- the commit you tested.

We aim to acknowledge reports within five working days. We will credit reporters who want credit.

This is a small open-source project with no bug bounty. **No independent security audit has been performed.**

## What RightClick X enforces, and where

All of these are enforced in code outside the language model:

- **Discovery.** It learns only what the operator points it at, under a network policy (private and metadata addresses blocked; egress allowlists). It investigates only local programs the operator authorises (`RCX_INVESTIGATE`).
- **Execution.**
  - Local programs run only in the host sandbox (macOS `sandbox-exec`, Linux bubblewrap). There is no network, writes go only to a temporary directory, and home directories cannot be read.
  - Limits apply to time, CPU, file size and output. Memory and process count have a sampled watchdog, not a hard kernel bound. The runtime terminates the run's process group on exit or a detected limit.
  - Destructive operations need operator approval (`RCX_APPROVE`) plus the caller's confirmation.
  - State-changing calls that may have taken effect are never re-sent automatically.
- **Credentials** are pinned to their origin. A caller's headers never follow a redirect to another origin. Credentials are redacted from audit logs and persisted errors, and cannot be fixed into published goals.
- **Publication and evidence sharing** are operator authorities (`authority.publish`, `RCX_SHARE_EVIDENCE`).

The full record, the adversarial tests and the residual risks are in [docs/north-star/SECURITY-STAGE1.md](docs/north-star/SECURITY-STAGE1.md).

## Known limits

- A process running as the same user can race to replace a program between its identity check and execution. Changes are detected after the run. File/network confinement does not establish complete resource containment.
- Memory and process count are sampled immediately and then at 100 ms intervals, with only one observation in flight. Short peaks can exceed the budget and complete between samples; resident-memory observations also do not establish a total allocation or footprint bound. Observer errors refuse the result, including after child exit. See the preserved failures and partial correction in [the sandbox resource assessment](docs/adaptive/SANDBOX-RESOURCES.md). A hard aggregate memory/process bound remains unestablished for native execution.
- `sandbox-exec` is deprecated by Apple, although it still ships.
- Windows has no sandbox implementation, so programs are never run there.
- Receipts form a tamper-evident hash chain kept by the same process. They are not independent attestation.
