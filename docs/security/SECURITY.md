# Security

EXAPT runs code a model wrote. This states what is enforced, what is only advisory, and what is not
established. No independent security audit has been performed.

## Enforced

**Generated programs**, in a disposable container for each run. `exapt doctor` attacks this boundary
rather than trusting the flags, and generated code is refused if it fails.

| Property | How | Checked by attack |
|---|---|---|
| No network | `--network none` | Yes |
| No host files | No mounts at all: source and input arrive over stdin | Yes, including the Docker socket and home directories |
| No credentials | Host environment is not passed in | Yes |
| Read-only system | `--read-only`; a size-limited `noexec` tmpfs for scratch | Yes, including writing and executing a script |
| No privilege | Unprivileged uid, all capabilities dropped, `no-new-privileges` | Yes |
| Memory and processes | Kernel cgroup limits, swap included | Yes, with an allocation bomb and a fork bomb |
| Time and output | Timeout here and inside the container; output capped here | Yes, with an infinite loop and a flood |
| Image | Pinned by content digest | |

**Authority.** The program list, data roots, budgets and publication policy come from configuration read
at startup. `test/security-boundary.test.ts` asserts that no argument of any agent-facing tool can widen
them. With `publish: "operator"`, an agent cannot publish, and only the operator's own command can.

**Agent input.** Goals from MCP or HTTP cannot name a file outside operator-declared roots. The HTTP
service binds to loopback and refuses other hosts and cross-origin requests, which also stops a web page
from reaching it through DNS rebinding.

**Verification separation.** A model never sees held-out data, oracles or verdict logic, and never judges
its own output. A test confirms that held-out inputs do not appear in any prompt, and another that a
model's claim of success changes nothing.

**Integrity.** Stored objects are content-addressed and checked on read. A bundle whose source does not
match its digest is refused. An imported capability has no standing until this host has reproduced its
checks, and it carries no authority or receipts from where it came from.

**Spending.** Model calls, tokens and cost are bounded per run, and checked before each call.

## Advisory only

- Environment programs run in RightClick X's native sandbox, not in a container. On macOS that is
  `sandbox-exec`, which Apple has deprecated. Network and file writes are denied, but its memory and
  process limits are sampled, not kernel-enforced, and short peaks can escape them.
- Program documentation and generated output reach models marked as untrusted data. A label is not a
  defence against prompt injection. What limits the damage is that a model can only propose text, and
  that text runs in the container.
- Timing and memory figures come from inside the container, so a hostile program could misreport them.
  They inform evolution and are not attested.
- Receipts form a tamper-evident chain, kept by the process that writes them. They are not independent
  attestation.

## Not established

- Protection against a container-runtime or kernel escape. Docker Desktop's Linux VM adds a layer on
  macOS, but this has not been tested against a determined attacker.
- Absence of covert channels through timing or resource use.
- Safety of side effects. The supported domain is pure transformations. Generated programs have no
  effects outside their output, so effects that follow from a wrong output are not contained.
- Correctness beyond the tested domain. A capability can be right on everything it was tested on and
  wrong elsewhere, and the [dogfood run](../experiments/dogfood/README.md) shows an overfit program passing
  every held-out case.
- Protection for a program that changes between its hash check and its use by another process run as
  the same user.
- Windows is unsupported: there is no native program sandbox there.

## Reporting

Report suspected vulnerabilities privately through GitHub's private vulnerability reporting.
