# Dogfooding to the north star

The north star, from the project brief:

> An agent encounters a computational task its existing capabilities cannot perform. EXAPT identifies the
> missing functionality, constructs a working new operation, experimentally validates it, permanently
> acquires that capability, and makes it available to another agent that did not participate in its
> creation.

Until this run, that had been shown only on fixtures written alongside EXAPT. This run used real work.

**Result: reached.** A Claude session with no shell got a test-output parser built. A Codex session, from
a different vendor, with no shared conversation and no model behind EXAPT, found and used it on files
nobody had seen. All six held-back real files came back exact. A later repair reached Codex with nothing
changed on its side. EXAPT's own release gate now runs on the capability.

Getting there exposed defects no fixture had found. They matter more than the success, so they are
listed in full.

## The real gap

EXAPT's release decision needs per-test results from `node --test`. Node prints TAP. An agent with only
EXAPT's tools has no way to read it.

- **Data.** Real output from EXAPT's and RightClick X's own test suites, 21 files holding 143 tests, plus
  hostile test files written to break the parser. Six RightClick X files were kept back from every party.
- **Truth.** Node's JUnit reporter, from the same run, read with Python's standard XML parser in
  [`truth.py`](truth.py). It shares nothing with EXAPT or the model.
- **Agents.** Claude Sonnet with MCP tools only, no shell. Then Codex CLI with MCP tools only.

## What happened

| Step | Agent | Outcome | Tool calls | Cost |
|---|---|---|---|---|
| First attempt | Claude | **Not established**: exposed defects 1 to 3 | 7 | $0.28 agent, $0.69 synthesis |
| Second attempt, after fixes | Claude | **Verified**: two candidates refuted, the third survived | 6 | $0.13 agent, $0.15 synthesis |
| Inheritance on unseen files | Codex | **Used it**, wrote no code | 4 | 19,937 tokens |
| Adversarial scoring | Harness | v1 had one real bug, and one impossible case | | |
| Repair | Claude | Overfit candidate, not published | 7 | $0.15 agent, $0.54 synthesis |
| Repair, real bug | Claude | Clean candidate, held back by a noisy gate | 11 | $0.20 agent, $0.17 synthesis |
| Re-verification, gate corrected | Scripted client | **Verified**, published as version 3 | 3 | none |
| Reuse of the repair | Codex | **Got version 3 automatically** | 6 | not measured |

Codex's first session was `exapt_discover`, `exapt_explain`, `exapt_use`, `exapt_use`. It was given no
capability id and there was no model behind EXAPT, so it could not have regenerated anything.

## Scoring

Scored by harness against the independent truth, not taken from any agent's report.

| Set | Version 1 | Version 3 |
|---|---|---|
| Six unseen real files | 6/6 exact, 53/53 tests | 6/6 exact, 53/53 tests |
| Adversarial, representable | 2/4 exact, 20/25 tests | **4/4 exact, 25/25 tests** |

Codex's output on the repaired behaviour matched truth exactly: 14/14 and 7/7.

The adversarial set covers Unicode, names that imitate TAP result lines, `#` in names and reasons,
failure text that looks like TAP, four levels of nesting, a failing `before` hook, and a file that
crashes before defining a test.

## What dogfooding found

Each of these was invisible to the fixtures and the test suite.

1. **One file can look like anything.** TAP was sniffed as a fixed-width table. EXAPT now requires the
   inputs to agree on a syntax, and treats them as text if they do not.
2. **Generated tests punished correct programs.** Candidates that passed the real data were rejected for
   throwing "not TAP output" on inputs EXAPT had made up from that wrong guess. For a corpus goal, truth
   exists only for real inputs, so nothing is generated now.
3. **A sample outranked stated truth**, and the model saw truncated examples. Truth now names the target.
4. **Format fit was treated as success.** New truth could not refute a retained capability, because its
   format still matched, so nothing would ever be repaired. A route must now reproduce stated truth.
5. **A repair came out as a new capability**, so nobody using the original would get it. A repair is
   now the next version of what it repairs.
6. **The mutation sample was too small to mean anything**, and it mutated comments. See below.
7. **The contract was unclear.** In its second session Codex audited the output, found parent tests
   absent, and called it incomplete. Leaf-only output was the intent, but nothing said so. That is now
   a stated limitation.

## A discovery about Node

The repair attempt found something nobody was looking for. In Node 26's TAP output, a real newline in a
test name and a literal backslash-n produce the **same bytes**:

```
test("real\nnewline")         ok 1 - real\\nnewline
test("literal\\nbackslash-n") ok 2 - literal\\nbackslash-n
```

The information is gone, so no program can recover it from TAP. What first looked like two wrong answers
in version 1 were impossible ones. This is recorded as a limitation of the capability. Node's JUnit
reporter also writes invalid XML for control characters such as form feed, which is why the final hostile
set avoids them.

## The overfit candidate, and a retraction

Asked to fix those impossible names, the model found a way to match the data anyway:

```js
const quoted = s.includes('"');
// ...
if (quoted) return "\\" + a;
return a === "n" ? "\n" : " ";
```

It treats a name differently because it contains a quote mark. That is nonsense as a rule. It works
because, in this corpus, the names with literal backslashes happened to contain quotes. **It passed all 18
files and every held-out case.** The source is in [`programs/`](programs/overfit-quote-hack.mjs).

It was not published, because it scored 0/5 on injected value faults. During the run that was described as
the mutation gate catching overfitting. **That description was wrong.** The clean repair then scored 1/6
under the same measure. The gate refused both for the same reason: it had too few faults to measure
anything, and the program's logic lived in regular expressions it did not touch.

With the standard logic operators added, a sample fixed by the program's own hash so that retrying
changes nothing, and the threshold left at 0.6:

| Program | Value faults caught | Against 0.6 |
|---|---|---|
| Version 1 | 15/18 (0.83) | passes |
| Clean repair | 11/18 (0.61) | passes |
| Overfit candidate | 7/18 (0.39) | refused |

That is the right ordering, on three programs. It is not a claim that mutation adequacy detects
overfitting. It measures the strength of a test suite. Here the two happened to align, narrowly.

**What is established:** an overfit program can pass every value oracle EXAPT has, including held-out
data, when that data does not happen to separate it from the truth. Evidence from finite tests has this
limit, and EXAPT is subject to it.

## A better signal

Comparing the three programs, with no truth at all, found every place the evidence ran out:

| Input | Version 1 | Overfit | Clean repair | What the disagreement shows |
|---|---|---|---|---|
| `r1`, row 4 | `leading spaces` | `  leading spaces` | `  leading spaces` | The real bug in version 1 |
| `z`, row 1 | `three leading…` | `   three leading…` | `   three leading…` | The same bug |
| `b1`, row 2 | `with\\na newline` | `with\na newline` | `with\\na newline` | The lossy newline |
| `amb`, row 1 | `real\\nnewline` | `real\nnewline` | `real\\nnewline` | The lossy newline |

Independently produced programs disagree exactly where the evidence does not determine the answer. This
needs no oracle, so it could help on the tasks where EXAPT currently has none. It is the top
engineering priority that this run supports.

## The release gate

`npm run gate` imports [`capabilities/node-test-results.bundle.json`](../../../capabilities/node-test-results.bundle.json)
into an empty home, where it must reproduce its checks before it can do anything. It then reads EXAPT's
own test output through the capability, and cross-checks the counts against Node's JUnit reporter from the
same run, so the decision does not rest on the capability alone.

## Reproducing this

Transcripts and tool-call logs are in [`transcripts/`](transcripts/). Generated programs are in
[`programs/`](programs/). `score.ts` and `gate.ts` are the scoring scripts as they were run; their paths
refer to the working directory of the run.
