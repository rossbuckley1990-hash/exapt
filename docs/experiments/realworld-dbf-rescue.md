# Real-world experiment: provable rescue of a dead binary format

Run on this machine, 2026-11-01. Not part of the preregistered benchmark; a separate probe of
whether the engine's central claim holds on real third-party data. Recorded before any
head-to-head against a model arm was run.

## Claim under test

EXAPT can be given an **empty output specification** plus examples whose truth it did not author,
induce the missing transformation itself, and establish the result at `verified-in-domain` —
with **zero model calls**, so no LLM wrote any of the code.

## Setup

- Task: `R1-dbf-natural-earth`. Real Natural Earth dBase files (dBase III, a 1984 format).
- Goal given to EXAPT: `{"intent": "Recover the records in these old table files as NDJSON",
  "corpus": [6 file/truth pairs], "want": {}}`. `want` is empty: no target program, no output
  sample, no examples. The output representation had to be inferred from the corpus alone.
- Authorised host programs: `/usr/bin/od`, `/usr/bin/file`.
- Model: `EXAPT_MODEL=none`. Strategy: `deterministic-only`.
- Workspace: `/tmp/exapt-realworld/R1`, holding only the 6 shown files. The 4 benchmark holdouts
  were never in it; verified by SHA-256 before the run (`leaked into workspace: 0`).

## Result

Invention completed. Producer: `binary layout induction`, mode `deterministic`.
Capability `exapt:binary-to-ndjson-e392ee@1`, status `verified-within-scope`,
level **`verified-in-domain`**.

Blind score on the 4 held-out real files, whose schemas appear nowhere in the workspace:

| Holdout | Bytes | Records expected | Records produced | Fields recovered | Match |
|---|---|---|---|---|---|
| 0 | 44,918 | 290 | 290 | 7 | yes |
| 1 | 136,728 | 19 | 19 | 43 | yes |
| 2 | 39,112 | 6 | 6 | 36 | yes |
| 3 | 22,267 | 3 | 3 | 39 | yes |

**4 of 4**, exact record-level comparison. Every run emitted a receipt
(`f5033edb12ed`, `fbfb2afedc86`, `1e2862c2b5d8`, `1574fe94e9f7`) and reported `verified-in-domain`.

Model calls: 0. Model cost: $0.00.

## What the evidence card discloses against itself

The retained capability's own card reports mutation testing as `killed 8 of 12` and **names the
four survivors**:

- offset sign flipped at 650
- literal changed at 297
- validation removed at 1088
- validation removed at 301

It also marks its oracles by independence: `target-representation` independent=false,
`ground-truth` independent=true valueLevel=true, `malformed-refusal` independent=false.
And it states its domain narrowly: `source: binary(magic:0375080c)`.

This is the part worth attention. The artifact does not merely assert success; it publishes the
bounds of what was established and the specific faults its own tests failed to catch.

## Caveats, stated plainly

1. **Not a benchmark result.** Arm A/B/C were not run, so there is no comparison against a coding
   agent yet. That EXAPT succeeded does not establish that a model would have failed.
2. **The corpus truth was authored by EXAPT's author**, via `check-corpus.py`. It is independent of
   the *engine* and was never shown to a model, but it is not independent of the *project*. The
   preregistration names this bias; it applies here.
3. **Four holdouts, one run.** No variance, no significance claim.
4. **`verified-in-domain` is scoped**, not universal. The domain is one magic number. Four survived
   mutations mean the verification is strong but not complete.
5. This ran from the working checkout, not from the `prereg-v1`-pinned checkout the benchmark
   requires.

## Why this matters

The interesting output is not the parser. Any competent agent can write a dBase parser. The
interesting output is that a machine **established** the parser against evidence, generalised it to
schemas it had never seen, and then volunteered the limits of that establishment — with no LLM in
the loop and no spec to work from.
