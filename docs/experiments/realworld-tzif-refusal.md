# Real-world experiment: TZif, and the refusal

Run on this machine, 2026-11-01. Preregistered in `tzif-preregistration.md` before EXAPT saw any
timezone file. Model: none. Strategy: `deterministic-only`.

## Result: it refused, and the refusal is the finding

Two runs, both `Not established`, **exit code 4** — the CLI's dedicated code for "ran but not
established", distinct from both success (0) and refusal-to-try (3).

| Run | Outcome recorded |
|---|---|
| `run_mvx4su7f_c0cf5817` | `layout induction: no fixed record layout explains where the known values occur` |
| `run_mvx4tqwz_3712bbdd` | `layout induction: a record layout was found, but neither a self-description nor all field positions could be established` |

The second run got further than the first — it found *a* layout — and still declined to claim it.

After both runs the vault is empty:

```
{ "capabilities": [], "total": 0, "workflows": [] }
```

Nothing was retained, nothing was published, no capability id was minted. **Zero false successes.**

Prediction **P1 is confirmed**: dBase is a fixed-stride record table, TZif is a header of six counts
followed by six count-dependent arrays, and `binary layout induction` is stride-based. It does not
reach this structure.

## What it got right before refusing

The refusal was not a blank failure. The analysis stage correctly established, from an empty `want`:

```
Missing transformation: binary(magic:545a6966) -> ndjson{at,utoff,dst,abbrev}
```

`545a6966` is `TZif`. It sniffed the real magic number from the bytes, and it inferred the exact
target representation — all four field names, in order — from the corpus alone, with no output
sample, no target program and no examples. It understood the task precisely, then reported that it
could not construct the transformation.

## The contrast that matters

Same engine, same host, same settings, same empty `want`, two real formats:

| | R1 dBase (Natural Earth) | R3 TZif (Apple zoneinfo) |
|---|---|---|
| Structure | fixed-stride record table | header counts + variable arrays |
| Outcome | `verified-in-domain` | `Not established` |
| Exit code | 0 | 4 |
| Blind holdouts | **4 of 4 passed** | not reached |
| Capabilities retained | 1 | **0** |
| Model calls | 0 | 0 |

This is the evidence ladder discriminating rather than rubber-stamping. A system that verifies
everything is worthless; the interesting property is that it succeeded on one real format and
refused on another, and that the refusal was accurate — TZif genuinely is not a fixed-stride table.

## Independent truth, and what it cost to build it

The truth was produced by `/tmp/exapt-realworld/oracle/tzoracle.c`, which calls `localtime_r` and
contains **no TZif parsing of any kind**. It asks Apple's libc what a zone does at an instant; it
cannot read the file. Cross-validated against a second independent Apple tool, `zdump`: New York
gave 136 transitions for 1970-2037 from the probe and 138 from `zdump -c 1970,2038` for its wider
window.

Ten real zones were used, all regular files, none symlinks. Six shown, four held out. The held-out
four each carry something absent from the shown six: `Pacific/Chatham` a +12:45/+13:45 offset,
`America/Sao_Paulo` a mid-series DST abolition, `America/Santiago` **TZif v3** where all six shown
files are v2. Isolation was verified by SHA-256 before the run: no held-out file or truth entered
the workspace.

Because EXAPT refused, the holdouts were never scored. They remain unused and unburned.

## Side finding: `date(1)` reports the wrong offset for historical instants

Building the oracle surfaced a reproducible defect in macOS `date`. For an instant where a zone's
offset has since changed, `%z` prints the zone's **current** offset while `date`'s own rendered
local time is correct — a self-contradiction inside a single invocation.

| Case | `date` renders | `%z` says | offset implied by that rendering | libc `tm_gmtoff` | |
|---|---|---|---|---|---|
| Apia 1970 | `1969-12-31 13:00:00` | `+1300` | `-1100` | `-1100` | mismatch |
| London 1970 | `1970-01-01 01:00:00` | `+0000` | `+0100` | `+0100` | mismatch |
| Kathmandu 1970 | `1970-01-01 05:30:00` | `+0545` | `+0530` | `+0530` | mismatch |
| Rangoon 1970 | `1970-01-01 06:30:00` | `+0630` | `+0630` | `+0630` | ok |
| London 2020 | `2020-09-13 13:26:40` | `+0100` | `+0100` | `+0100` | ok |
| Kathmandu 2020 | `2020-09-13 18:11:40` | `+0545` | `+0545` | `+0545` | ok |
| Santiago 1970 | `1969-12-31 21:00:00` | `-0300` | `-0300` | `-0300` | ok |
| Apia 2012 | `2012-01-01 13:00:00` | `+1400` | `+1400` | `+1400` | ok |

Mismatch occurs exactly when the zone's offset has changed since the queried instant. Controls at
modern instants all agree. London at epoch really was UTC+1 — the UK's 1968-71 permanent British
Standard Time experiment — so the rendering is right and `%z` is wrong.

Severity, honestly: this is a formatting correctness defect in a legacy CLI. There is no memory
safety, privilege or exposure angle, so it is not a security vulnerability and Apple Security
Bounty eligibility is effectively nil. It is worth a Feedback Assistant report as a correctness
bug. Its value here is as an instance of the failure mode EXAPT is built around: a ubiquitous real
tool returning a confidently wrong answer with nothing in its interface to warn the caller.

## Caveats

1. **Two runs of one task on one format.** No variance measured.
2. **The refusal bounds the synthesiser, not the format.** TZif is entirely parseable; what failed
   is `binary layout induction`'s stride assumption. A model-proposed parser was not attempted
   (`EXAPT_MODEL=none`), so this says nothing about whether EXAPT can *verify* one.
3. **The oracle probe is my code.** It contains no TZif parsing and cannot invent the answers, and
   it agrees with `zdump`, but I wrote it and chose the window.
4. **The window (1970-2037) is not stated in the goal** and would have to be inferred from the
   shown truth files. Whether EXAPT could have inferred it was never tested, because synthesis
   failed earlier.
5. Ran from the working checkout, not the `prereg-v1`-pinned one.
