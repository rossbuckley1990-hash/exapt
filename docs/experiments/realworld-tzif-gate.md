# Real-world experiment: the gate

Run on this machine, 2026-11-01. Same preregistration as `realworld-tzif-refusal.md` — zones,
window, split and scoring were frozen before any run. This is the model arm that the refusal
experiment deliberately left untested.

## Question

`realworld-tzif-refusal.md` established that deterministic synthesis refuses TZif, and that the
refusal is accurate. It left open the question that matters for the product: **can EXAPT establish
whether code that a model wrote is actually true?**

A gate that only certifies good code is a rubber stamp. This run tests certification against
independent truth, integrity against tampering, and the disclosed blind spots against reality.

## Result

Deterministic induction failed again first, then the model was asked:

```
[synthesis.note] layout induction: a record layout was found, but neither a self-description
                 nor all field positions could be established
[candidate.proposed] claude-cli/sonnet
[candidate.survived]
[verified]
```

Capability `exapt:binary-to-ndjson-03b2fc@1`, status `verified-within-scope`, level
**`verified-in-domain`**, reached at `passed-holdout` on round 1 with no failures.

| | |
|---|---|
| Model calls | 2 |
| Tokens | 7,134 in / 4,196 out |
| **Cost** | **$0.057903** |
| Generated source | 2,007 bytes |
| Candidate sha256 | `658960de3a47efafcc0948d04eb3c6dcbcc6bf0f8d55b644d0994c2a9334470f` |

### Blind score, four held-out zones, never in the workspace

Truth is Apple's libc via `localtime_r`. Comparison is the benchmark's own
`compareOutputs(..., "records")`.

| Zone | Bytes | Expected | Produced | Match | Receipt |
|---|---|---|---|---|---|
| America/Santiago (**TZif v3**) | 2,515 | 135 | 135 | yes | `c4ec446d62f5` |
| America/Sao_Paulo (DST abolished mid-series) | 1,430 | 69 | 69 | yes | `85a301361321` |
| Europe/London | 3,664 | 134 | 134 | yes | `6710b1cdb4e0` |
| Pacific/Chatham (+12:45/+13:45) | 2,054 | 128 | 128 | yes | `fc82977e1bcc` |

**4 of 4**, exact.

**Prediction P2 is refuted.** It predicted failure on `America/Santiago` because it is v3 while all
six shown files are v2. The generated parser branches on `version >= 0x32`, skips the 32-bit block
to reach the 64-bit one, and handled v3 exactly. The held-out set also carried an offset (+12:45)
and a pattern (mid-series DST abolition) absent from the shown six. Both passed.

The generated code is competent rather than lucky: it validates magic and bounds, checks every
type index before use, reads abbreviations by scanning to the NUL, and — the subtle part — seeds
the epoch state by walking transitions `<= 0` rather than assuming `types[0]`, which for most
zones is LMT and would be wrong.

## Does the gate have teeth?

### Integrity: yes

The exported bundle carries a `digest`. Tampering with `source` while leaving the digest intact:

```
control (untampered)  -> EXIT=0  {"outcome": "accepted-import", ...}
tampered              -> EXIT=1  error: bundle source does not match its declared artefact digest
```

The tamper was a single semantic change, `times[k] <= 0` to `times[k] < 0` — small enough to be
invisible in review. It was refused on digest, before any execution.

### The disclosed blind spots: real, and on inspection benign

The evidence card reports mutation testing as `killed 6 of 12` and names all six survivors:
`offset sign flipped at 1296`, `literal changed at 1852`, `offset sign flipped at 662`,
`validation removed at 145`, `validation removed at 294`, `validation removed at 938`.

Offsets 145, 294 and 938 are the `bad TZif magic`, `bad header` and `no types` guards. I removed
the outer magic guard and ran the mutant against a text file and against a real dBase file:

```
certified:  garbage.bin -> refused (bad TZif magic)   dbf.bin -> refused (bad TZif magic)
mutant:     garbage.bin -> refused (bad header)       dbf.bin -> refused (bad header)
```

Both still refuse. The inner `header()` re-checks magic at offset 0, so the outer guard is
redundant — defence in depth. That is why the mutation survived: removing it changes nothing
observable. The survivor is disclosed honestly and is not a hole.

This is the behaviour worth copying. The system did not report "verified" and stop; it published
the specific faults its tests failed to kill, which let a reviewer check whether they matter.

## Open discrepancy, unresolved

The publish run reported `workflow: { ok: false, output: "" }` while the CLI still returned exit 0,
because exit 0 keys on `capability.status === "verified-within-scope"`. The capability itself works
— all four blind holdouts pass through `exapt use` with receipts. So the failure is in the
end-to-end workflow step, not in the parser, and is most likely an artefact of this goal having no
`want.program` and therefore no workflow to complete. The equivalent step succeeded on R1.

I did not establish the cause. It should be investigated before this result is quoted, because a
run that reports a failed workflow alongside exit 0 is exactly the kind of contradiction the
project exists to eliminate.

## What the three experiments say together

| | R1 dBase | R3 TZif, no model | R3 TZif, gate |
|---|---|---|---|
| Synthesis | deterministic | none | model, after deterministic failed |
| Outcome | `verified-in-domain` | `Not established` | `verified-in-domain` |
| Exit code | 0 | **4** | 0 |
| Blind holdouts | **4 / 4** | not reached | **4 / 4** |
| Retained | 1 capability | **0** | 1 capability |
| Cost | $0.00 | $0.00 | $0.058 |

Two real formats, both with truth EXAPT's author did not write. It established one without a model,
refused the other accurately rather than guessing, then established the second by verifying a
model's code against an operating system's own libc — for six cents.

The claim this supports is not that EXAPT writes better parsers than a model. Sonnet wrote this
one. The claim is that **the machine, not the model, decided whether it was true** — and that when
it could not decide, it said so with a distinct exit code and retained nothing.

## Caveats

1. Four holdouts, one run, one model. No variance, no significance claim.
2. The libc probe is my code. It contains no TZif parsing and agrees with `zdump`, but I wrote it
   and chose the 1970-2037 window.
3. The window is not stated in the goal and had to be inferred from the shown truth files. The
   model may have inferred it from the corpus rather than from the format; this run cannot
   distinguish those.
4. Model synthesis means the parser is Sonnet's work. This measures verification, not invention.
5. The `workflow.ok: false` discrepancy above is unexplained.
6. Ran from the working checkout, not the `prereg-v1`-pinned one.
