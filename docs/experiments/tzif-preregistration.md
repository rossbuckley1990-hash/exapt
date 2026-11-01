# TZif preregistration

Written and committed to disk before EXAPT was run on any timezone file. If the run goes badly,
this file is the record of what was fixed in advance, and it is not to be edited afterwards.

Date: 2026-11-01. Machine: this MacBook, macOS, `/usr/share/zoneinfo`.

## Why this task

The dBase result (`realworld-dbf-rescue.md`) established that EXAPT can induce a transformation
from an empty specification with zero model calls. Its weakest point is that the corpus truth was
authored by this project's author.

TZif removes that. The truth here comes from **Apple's libc**, via a C probe that calls
`localtime_r` and contains no TZif parsing whatsoever. The probe cannot read the file; it asks the
operating system what a zone does at an instant. The probe's author wrote no timezone code and
cannot make the answers come out any particular way. A second independent Apple tool, `zdump`,
agrees with it (New York: 136 transitions found by the probe for 1970-2037, 138 reported by
`zdump -c 1970,2038` for its wider window).

TZif is also genuinely harder than dBase. dBase is a fixed-stride record table. TZif is a header of
six counts followed by six variable-length arrays whose lengths depend on those counts, then — in
v2 and v3 — a *second* complete block with 64-bit times, then a POSIX rule footer as text. Whether
`binary layout induction` reaches this structure at all is the open question.

## Recovery target

From the bytes of a compiled timezone file, produce NDJSON records of the zone's offset changes:

```
{"at":<epoch seconds>,"utoff":<seconds east of UTC>,"dst":<0|1>,"abbrev":"<name>"}
```

The first record is the state in effect at the start of the window; each later record is an exact
transition second.

## Window, fixed in advance

`0` (1970-01-01T00:00:00Z) to `2145916800` (2037-12-31T00:00:00Z), for every zone, shown and
held out alike. This range is chosen because it is covered by the file's own 32-bit transition
table, so no POSIX-rule extrapolation is required. The window is not stated in the goal; it is
present consistently in every shown truth file, and must be inferred like everything else.

## Goal given to EXAPT

```json
{"id":"R3-tzif-zoneinfo","intent":"Recover the offset changes recorded in these compiled timezone files as NDJSON","corpus":[6 pairs],"want":{}}
```

`want` is empty. No target program, no output sample, no input/output examples. This matches R1.

Authorised host programs: `/usr/bin/od`, `/usr/bin/file`. Model: `EXAPT_MODEL=none`.
Strategy: `deterministic-only`. No LLM writes any code in this run.

## Zones

All ten are regular files, not symlinks. Transition counts are as reported by the libc probe over
the fixed window.

**Shown to EXAPT (6)** — the workspace contains the file and its truth:

| Zone | Bytes | Transitions | Why chosen |
|---|---|---|---|
| America/New_York | 3552 | 136 | dense northern-hemisphere DST |
| Asia/Tokyo | 309 | 0 | no transitions at all |
| Asia/Kathmandu | 198 | 1 | +5:45, a single historic change |
| Australia/Lord_Howe | 1846 | 114 | 30-minute DST, unique |
| Pacific/Apia | 598 | 23 | crossed the date line in 2011 |
| Antarctica/Troll | 1148 | 67 | DST at +0/+2, unusual abbreviations |

**Held out (4)** — never in the workspace, scored blind:

| Zone | Bytes | Transitions | What is new about it |
|---|---|---|---|
| Europe/London | 3664 | 133 | different abbreviation set |
| Pacific/Chatham | 2054 | 127 | +12:45/+13:45 — an offset absent from the shown set |
| America/Sao_Paulo | 1430 | 68 | DST abolished mid-series — a pattern absent from the shown set |
| America/Santiago | 2515 | 134 | **TZif v3** — every shown file is v2 |

The held-out set is deliberately harder than a random draw. Each of the four carries something the
six shown files do not: an unseen offset, an unseen DST-abolition pattern, an unseen file version.
This is the same discipline as R1, whose holdouts had other schemas.

## Scoring, fixed in advance

- A held-out zone **passes** if EXAPT produces records that match the libc truth by record
  comparison, using the benchmark's own `compareOutputs(..., "records")`.
- A **false success** is any claim of success where a held-out zone fails. This is the outcome that
  matters most, as in the main preregistration.
- A **refusal** scores as a refusal. It is not a failure of the experiment; establishing where the
  engine stops is one of the two acceptable results.
- Partial credit is not given. Either a zone's records match or they do not.

## Predictions, stated so they can be wrong

- **P1.** The most likely outcome is refusal or failure. dBase is a fixed-stride table; TZif is not.
  If `binary layout induction` is stride-based, it will not find six count-dependent arrays.
- **P2.** If it does succeed, it will succeed on the v2 zones and fail on `America/Santiago` (v3),
  because v3 changes the header's reserved bytes and the footer.
- **P3.** Zero-transition zones (Tokyo) are the most likely to be handled correctly if anything is,
  because they are degenerate.

## What would falsify the interesting claim

If EXAPT reports a high evidence level and then fails a held-out zone, the evidence ladder is not
doing its job — that would be a real defect and the most important thing this experiment could
find. Passing its own tiers and then failing blind is exactly the false success the ladder exists
to prevent.
