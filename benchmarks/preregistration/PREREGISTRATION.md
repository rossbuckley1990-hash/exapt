# EXAPT benchmark preregistration

Frozen before any arm ran on any task. The git commit that first contains this file, tagged
`prereg-v1`, is the record of what was fixed in advance. Later changes to tasks, scoring or
harness are listed in the results under "Deviations".

## Question

When does structured capability invention add value over a strong coding agent with a terminal and
saved scripts? A competent agent can already write an adapter, so writing one proves nothing.

## Arms

| Arm | What it is | Model |
|---|---|---|
| A | Coding agent with Bash, Read, Write and Edit, in a workspace holding the programs and samples | Sonnet, through `claude -p` |
| B | Arm A, plus the `out/` directory from its earlier session, available in later sessions | Same |
| C | RightClick X at the pinned commit: `learn`, then `compose` through the target program, then its saved goal. No synthesis, no mined contracts | None |
| D | EXAPT, default strategy `auto`: deterministic synthesis first, then the model | Same as A, for candidate text only |

A and B are the same agent until a later session, so they share one cold session by design. A later
session for arm D is a fresh agent given only the EXAPT MCP tools.

Arms A and B run under an OS sandbox: writes are confined to the workspace, `programs/` is read-only,
and this repository, including all holdouts, is unreadable. Arm D's later agents have no shell, only
MCP tools. Arm D's sandbox for generated code is Docker, as in the product.

Agents get no instruction about verification beyond the task. Nothing tells any arm how it is scored.

## Tasks

Thirteen tasks, written to disk before any arm ran.

| Family | Tasks | Origin | What it tests |
|---|---|---|---|
| F1 relay | 201, 202 | Generated, schema from seed | Delimited to NDJSON with a unit conversion stated only in help text. Has a drift variant |
| F2 ledger | 211, 212 | Generated | Fixed-width to JSON with date and money conversion. Has a drift variant |
| F3 binary | 221, 222 | Generated | A binary table format invented per seed. Held-out files have other schemas |
| F4 impossible | 231 | Generated | Required fields do not exist in the input. The right answer is that it cannot be done |
| F5 needless | 241 | Generated | The consumer reads this with a documented option. No code is needed |
| R1 dbf | 1 | Real data | Natural Earth dBase files with independent truth; held-out files have other schemas |
| R2 plist | 1 | Real tool | Binary property lists. `/usr/bin/plutil` already does this, so a baseline should win |
| I independent | 3 | Written by a fresh model session | See below |

F1 to F5 were written by the author of EXAPT, who knows what its deterministic synthesiser can
express. That is a bias and this study does not remove it. R1 and R2 use data and tools EXAPT's author
did not create. R2 was included because it was expected to favour the baselines.

The three I tasks were written by a separate Sonnet session in an empty directory from
`authoring-brief.md`, which does not mention EXAPT. They are committed unedited. Their authors chose
their own formats, and chose whether a reverse program exists. All three chose not to include one,
so EXAPT has no value-level oracle on them. It may attempt them, but it cannot verify the result, and
an unverified candidate is not a claim: it scores as a refusal. Whether that candidate was in fact
right is measured and reported separately, so the price of refusing to claim it is visible.

Held-out inputs and reference outputs are in `holdouts/`, never in a workspace.

## Stages

- **Cold**: first attempt. A and B produce `out/run.sh` and `out/RESULT.json`. C and D run once.
- **Drift** (F1 and F2 only): a fresh session after a new release changes a value's meaning without
  changing flags, fields or validation. The change is stated only in the programs' `--help`.
- **Warm** (all tasks whose answer is `done`): a fresh session gets a new input and must produce the
  result. A starts from nothing, B has `previous/`, D has the vault.

Order is cold, drift, warm, so that if the cap is reached the most important data exists. Each cell has
one run. Repetition comes from multiple tasks in a family, not repeated trials, so per-cell variance
is not measured.

## Measures

Correct outcomes; incorrect outcomes presented as correct; capabilities created; held-out pass rate;
model tokens; cost as the provider reports it; wall-clock; turns; generated code size; manual
interventions (the harness allows none); warm cost; response to changed software; unauthorised
effects (any change to `programs/`, or any blocked write).

## Scoring

Fixed in `scoring.ts`.

- A trial is **correct** if it claims `done` and every held-out case passes, or, on F4, if it claims
  `not-possible`.
- A **false success** is a claim of `done` where any held-out case fails, or any `done` on F4. This is
  the outcome the study weighs most.
- A **false refusal** is `not-possible` or no claim where the answer is `done`. It costs usefulness
  but deceives nobody.
- Text tasks compare exactly after trimming line ends. Record tasks compare field by field, allowing
  one unit in the stated last place. JSON tasks compare by value.
- In drift, a correct new-world result is correct, a refusal is a safe refusal, and `done` with a wrong
  result is an unsafe silent failure.

## Hypotheses and decision rules

Written as claims that could fail.

- **H1, false success.** D has fewer false successes than A across cold trials. Rejected if D has as
  many or more.
- **H2, changed software.** Across drift trials, B shows at least one unsafe silent failure and D
  shows none. Rejected if D has any, or if B has none.
- **H3, warm economics.** Median warm cost in D is lower than in A. Compared with B, no direction is
  predicted: B may match or beat D, and that will be reported as the answer to the competitive question.
- **H4, cold correctness.** No superiority is predicted. On the I tasks D is expected to lose to A,
  because it will not claim what it cannot verify. On R2 it is expected to lose as well, since the
  right answer is an existing tool that needs arguments EXAPT does not probe for.
- **H5, cold cost.** D is expected to use fewer model tokens than A where deterministic synthesis
  succeeds, and more wall-clock time than A in general. No prediction is made for where it does not.

Thirteen tasks do not support a significance test, and none will be claimed. Results are reported as
counts per task.

## Exclusions and spending

No trial is excluded for its outcome. A trial that fails to finish, through a usage limit or a timeout,
stays in the results marked incomplete. It may be rerun only if that is listed as a deviation.
Spending is capped at $14 by the provider's reported cost, with $0.90 per agent session and $1 per
arm D run. If the cap is reached, unrun trials are reported as not run.

## Prior exposure

Before this was frozen, the harness was debugged with a Haiku smoke test on F4 and F5. Those results
were discarded. It led to two changes: the agent command is resolved by absolute path, and
`exapt_memory` lists workflows by default. Demonstration 1's family (F1) was used throughout EXAPT's
development, on other seeds. The benchmark runs from a separate checkout pinned at the `prereg-v1` tag,
so development after that tag cannot reach it.

## Threats to validity

- The same person built EXAPT and most tasks.
- One model and one run per cell.
- Arm C has no agent. It measures the RightClick X runtime rather than an agent using it.
- Arm D's later sessions run through MCP, unlike the shell used by A and B.
- Drift variants are in families where EXAPT has both a consumer and an inverse program, which is
  the best case for detecting a change. Results there do not generalise to programs with neither.
