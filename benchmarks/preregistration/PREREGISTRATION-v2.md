# Second preregistration: confirmatory round

Written after the primary benchmark, whose results led to changes in EXAPT. Those results cannot judge
the changes, because the changes were made by looking at them. This round uses tasks EXAPT has never
been run on. The tag `prereg-v2` records what was fixed before any arm ran.

## What changed since the primary round

From dogfooding: stated truth outranks format fit, repairs keep their identity, corpus goals are judged
on real inputs, mutation sampling is fixed per program and uses standard logic operators.

From the primary results: positive samples may be suggested by a model and confirmed by running the
program; fractional targets are kept only where the inverse can distinguish them; test inputs are
not invented when a program can produce them; local date forms are understood; the missing-information
test no longer rules out conversions between kinds of value.

The verification gate's threshold is unchanged at 0.6, and no standard of evidence was lowered.

## Tasks

Seven tasks, none seen by any arm before this round.

- F1 relay, seeds 301 and 302. F2 ledger, seeds 311 and 312. New seeds of known families, which do
  exercise known code paths, so these show less than the independent tasks do.
- I4 vineyard ledgers, I5 amateur radio logs, I6 ferry timetables. Written by fresh Sonnet sessions from
  the same unmodified brief. Committed unedited, and not read by the author of EXAPT beyond their
  names, before this was frozen. I6's session hit the harness timeout after writing its files, and its
  files are used as they stood.

## Arms, stages, scoring

As in the primary preregistration: A, B, C and D with Sonnet; cold, then drift on F1 and F2, then warm.
Scoring is `scoring.ts`, unchanged. Spending cap: $7.

## Predictions

Stated so that they can be wrong.

- **P1.** EXAPT is no longer stopped by missing doc samples: on I4 to I6 it reaches an attempt on at
  least two of three.
- **P2.** On I4 to I6 it verifies none, if no program writes the source format back, since it then has no
  value-level oracle. Its unverified candidates may still be correct, and that is measured.
- **P3.** On F1 and F2 it is correct on at least three of four.
- **P4.** It has no false success in any stage.
- **P5.** Arm A is correct on at least as many cold tasks as arm D. EXAPT is not predicted to win on
  cold correctness.
- **P6.** Warm cost through EXAPT stays above arm B's.

As before, seven tasks support no statistical claim.

## Prior exposure and threats

The same as the primary round, except that all seven tasks are new to every arm. One run per cell.
F1 and F2 are the author's own families.
