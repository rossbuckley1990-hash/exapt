# AEGIS Demonstration 4: independent audit and replication

This audit reviews a prior agent's experiment. It is independent of the synthesising model and
uses a separately written Python oracle. It is not an external human review or a formal proof.

## Preserved history

Six original development attempts were recovered and copied, including their runs, candidate
objects, contracts, usage logs and reports. Three refused, one failed with a runtime error,
one exhausted synthesis, and one succeeded. The available logs record **$0.375245** across the
six attempts, not merely the successful attempt's $0.0372102. Missing unrecorded usage cannot be
recovered. Full inventory and SHA-256 hashes: `benchmarks/results/aegis4-originals/inventory.json`.

The successful original artefact SHA-256 is
`4de6e1a7b9df71bac9a080fcf5e3b61ce4a1599ffd767249c0b9b2a58bf77a8a`.
It is reproduced as bytes from its content-addressed object, not copied from a report's code block.
Its original run is `run_mvx50aqj_83f3ed7d`.

Two historical provenance gaps remain: the complete model prompts/replies were never retained,
and the exact dirty implementation checkout was not pinned. Character counts, extracted candidates
and usage metadata cannot reconstruct a model transcript or the full original implementation.
Consequently the new end-to-end run is a replication on a recorded implementation, not a claimed
bit-for-bit reproduction of an unavailable historical checkout.

## Reproduction and independent checks

`node benchmarks/aegis4/audit.ts` validates archived hashes, attacks the Docker boundary, runs the
original candidate, all three original negative controls, and all mutants produced by the current
mutator against 21 cases. The oracle is `benchmarks/aegis4/oracle.py`; it has no EXAPT imports and
does not call or embed the generated implementation. Expected integer products use Python integers.

Observed audit: `benchmarks/results/aegis4-audit-1793496442274/report.json`.

- All ten isolation probes passed: connectivity denial, read-only root, absence of host mounts and
  credentials, unprivileged execution, memory/process limits, timeout and output cap, plus harness
  operation. These probes do not prove resistance to kernel/runtime escapes.
- The original candidate passed **19/21** audit cases. It accepted duplicate labels and a junk
  prefix before the header under the audit's two newly explicit stricter requirements. These are
  recorded weaknesses outside what the original tiny malformed suite established.
- Fresh live `/usr/bin/vm_stat` input matched the independent oracle exactly. The invocation took
  **410 ms** on this run and emitted receipt
  `101af98ab63be7cf43ee99a9ee8102a0aa85a03f304990c2012420e905c0bf01`.
- All negative controls failed valid value checks; their complete per-case successes and failures
  remain in the audit, including cases on which an incorrect program happens to behave correctly.

The collector is a schema/scale check, not a conservation-law oracle. A separate counterexample
made all six values four times too small while satisfying its divisibility and old minimum-total
checks; it accepted 4.22 GiB. Independent expected values are what detect that error. Summing
selected metrics is not an independently measured physical-memory total.

## The surviving 2/3 value mutant

`literal changed at 206` replaces `lines.length === 0` with `lines.length === 1`.
Both versions reject zero-line input (explicit rejection versus missing-header exception). Both
reject one-line input (missing required metrics versus explicit rejection). With at least two
lines, both follow the same code. Thus the mutation is equivalent for successful output and
rejection under a contract that does not prescribe exact exception messages. Exact error text
differs. All 21 audit cases confirmed the same outputs/refusal outcomes for this pair.

The original **2/3 value**, **2/11 total** scores are preserved. The equivalent mutant has not
been removed to manufacture a perfect score. Other surviving mutants retain their identities and
results; equivalence of one mutant says nothing about the rest.

## Strengthening and new full run

Generic changes require at least three *distinct* holdout inputs with independent value checks,
include holdouts in final mutation assessment, and record mutant hashes and killing test IDs.
These changes contain no telemetry-specific transformation. The telemetry fixture now supplies
12 public corpus pairs, declares unique statistic labels and a valid header as its domain,
fails when live host capture is unavailable, and avoids claiming physical conservation.

The first replication failed before model access because Node could not find package metadata
within the authorised program directory. This is retained at
`benchmarks/results/aegis4-replication-1793496547876`. Adding local fixture metadata corrected the
environmental failure; no scored trial was overwritten.

The subsequent full replication is in
`benchmarks/results/aegis4-replication-1793496588286`:

| Measure | Observed |
|---|---:|
| Model calls | 2 |
| Provider-reported cost | $0.046755 |
| Full run elapsed time | 216.132 seconds |
| Visible / independent / holdout cases | 4/4, 3/3, 5/5 |
| Malformed / metamorphic checks | 2/2, 7/7 |
| Value mutants / all mutants rejected | 13/13, 19/21 |
| Additional synthetic snapshots | 6/6 |
| Live invocation | 1,729 ms; no new model call |

Full public-data prompts and replies are stored in `transcript/` with hashes. Candidate code,
verification evidence, limitations and receipts are in that run's `.exapt/` directory. The two
surviving mutations remain recorded. This is a new candidate under stronger tests, not a rewritten
score for the original candidate. Timings reflect concurrent validation on this Mac.

## Limits and next experiment

This establishes one bounded telemetry conversion and rejection of specific faults. It does not
establish universal invention, zero hallucination risk, mathematical behavioural equivalence, or
superiority to a coding agent. The stronger gate also causes existing DBF continuity expectations
to fail; the full validation log is retained in `benchmarks/results/aegis4-checks/full-test.log`.

AEGIS-5 is a separately selected blind pilot, with a frozen implementation and a real coding-agent
baseline that can save scripts. Its preregistration is `benchmarks/aegis5/PREREGISTRATION.md`.
The first freeze hash is `ca15dc7849816bbec72e6e992de9a7c55b13202ab124a320ed77c6c24854968b`.
Failures and ties are admissible outcomes; no breakthrough claim follows from this audit.
