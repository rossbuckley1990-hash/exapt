# Architecture

EXAPT turns a missing computational capability into a verified, retained operation. It has six
engines over a vendored RightClick X runtime, and one interface shared by the CLI, the HTTP service
and the MCP server.

## The five parties

An invention involves five parties, kept apart on purpose.

| Party | Where it runs | Can do | Cannot do |
|---|---|---|---|
| Planning model | Behind an adapter | Propose text | Run anything, see held-out data, judge its own output |
| Orchestration runtime | This process | Schedule, record, decide levels | Run generated code in-process |
| Generated program | Disposable container | Compute on its input | Reach the network, the host, or any credential |
| Verification oracles | Native sandbox, or data | Judge outputs | Be influenced by a candidate |
| Operator authority | Configuration read at startup | Authorise programs, set budgets, approve publication | Be changed from any agent-facing call |

## The flow

```
Goal
 └ Engine A  mine what each program really reads and writes, by experiment
 └ Engine B  run forward from what you have, walk back from what you want
              ├ they meet: nothing to invent
              └ they do not: rank the missing edges, and find the oracles for each
 └ Engine C  propose programs: enumerative search, layout induction, or a model
 └ Engine D  try to refute each one, and feed refutations back
 └ Verification  a fresh, separate assessment sets the evidence level
 └ Engine E  retain a versioned operation, in both graphs
 └ Engine F  bounded improvement, by versioned promotion
```

## Engine A: capability universe

`packages/capability-universe`

RightClick X types a value semantically, so every delimited file, log and report is `text`. That cannot
say whether one program can read what another writes. A **Repr** is the finer description EXAPT plans
with: the syntax of a value and the shape of its fields, inferred from real bytes.

The **contract miner** establishes each program's interface by experiment. It starts from a positive
sample, from the documentation, from another program's output, or suggested by a model. It confirms the
sample by running it, then perturbs it. Removing a field shows what is required. Changing one shows
what is read. Offering a fraction shows whether a field is really integral. Each claim is an observation
in the sandbox.

Capability nodes carry one of six statuses: `existing`, `candidate-missing`, `synthesised-unverified`,
`verified-within-scope`, `invalidated`, `refused`.

## Engine B: missing-capability reasoner

`packages/gap-reasoner`

Reachability is witnessed. Forward search actually runs every program that accepts a value, and keeps
what it produced. Backward search walks from the goal to every representation that would be enough. A
route exists when they meet. Where stated truth exists, a route must also reproduce it: a matching
format is not a right answer, so new evidence can refute something retained.

When they do not meet, each pair of reachable value and sufficient representation is a candidate gap,
scored on feasibility, oracle strength, complexity, reuse, downstream reach, cost, risk and semantic
confidence. Documented options are tried before any code is written. A target needing fields nothing
in the source can supply is reported as not constructible.

**Exaptation is the central idea.** The graph supplies more than the gap. A program that writes the
target format back into the source format is an oracle, and yields worked examples. A consumer tests
acceptance. A producer generates test inputs. Tools built for something else become the instruments
that verify what is being built.

## Engine C: synthesiser

`packages/synthesiser`

A portfolio, with every candidate's producer recorded.

- **Lens search** (`lens.ts`) infers the syntax on each side, aligns records, and searches a small
  expression language bottom-up for each target field, keeping one expression per distinct behaviour.
  Linear conversions come back as exact rationals. There is no table of formats.
- **Layout induction** (`layout.ts`) recovers fixed-record binary formats from worked examples, finding
  record sizes from where values recur, header slots from what they must equal, and any table in which
  the file describes itself. It carries no knowledge of any format.
- **Model synthesis** (`model.ts`) works from a specification, visible examples and counterexamples.

## Engine D: falsification

`packages/experiment-engine`

Tests come in tiers with different visibility.

| Tier | Seen by the synthesiser | Purpose |
|---|---|---|
| Visible | Yes | Worked examples |
| Independent | As counterexamples | Drawn fresh each round |
| Boundary | As counterexamples | Valid extremes |
| Malformed | As counterexamples | Input a correct program refuses |
| Held out | Never | Redrawn for each candidate that gets this far |

Oracles are qualified before they are trusted. Tolerances through an inverse are measured. A field the
inverse does not carry is excluded. A boundary class the inverse cannot represent is judged another way,
and the limitation is recorded. For a corpus goal, truth exists only for real inputs, so nothing is
generated.

Evidence levels form a ladder: `not-established`, `syntax-valid`, `executed`, `passed-visible`,
`passed-independent`, `passed-holdout`, `verified-in-domain`. The top rung needs a value-level
independent oracle on held-out cases, consumer acceptance where there is a consumer, and enough
injected faults caught.

**Mutation adequacy** injects faults into the accepted program and measures how many the suite catches.
It measures the strength of the suite. It does not detect overfitting; see
[the dogfood report](../experiments/dogfood/README.md).

## Engine E: memory

`packages/capability-memory`

A capability is a portable manifest: content-addressed artefact, contract, dependency pins, evidence,
limitations, rejected attempts, provenance and a revalidation suite. Storage is plain files: JSON
manifests, content-addressed objects, append-only event logs, written atomically. SQLite was not needed.

Every use checks dependency hashes. A changed dependency triggers revalidation against the stored suite
and against **behaviour witnesses**, recorded outputs of the consumer. A semantic change that keeps the
same flags and fields is caught by those. Failure invalidates the capability and everything built on it.

An imported definition has no status until this host has reproduced its checks. Authority never travels.

## Engine F: evolution

`packages/evolution`

A bounded attempt against one objective. A candidate must pass everything its predecessor passed and
show a measured improvement to become a new version. Deletion search needs no model. Only a generated
artefact can change: EXAPT's runtime and policy are never candidates.

## What came from RightClick X

`vendor/rightclick-x` holds RightClick X at commit `278d66c`, byte-identical, with hashes in
`UPSTREAM.json`. Nothing in it is modified. Reached through `packages/rcx-adapter`.

| Reused unchanged | Extended around | New in EXAPT |
|---|---|---|
| Program investigation, options, subcommands | The miner goes further where generic probes fail | Contract miner, Repr algebra |
| Capability graph, types, search | Mined and generated nodes are added to it | Gap reasoning, oracle mining |
| Native program sandbox | Narrowed to the operator's program roots | Container boundary for generated code |
| Receipts, ledger, execution policy | Every program and capability step produces receipts | Evidence ladder, verification |
| OpenAPI, GraphQL, MCP reflectors, `context_*` tools | Reached through `exapt_rcx` | `exapt_*` tools, Lab |

The one seam into private state is RightClick X's builtin table, used to register generated capabilities
as real operations. `test/vendor.test.ts` pins it.

`vendor/` is a copy rather than a dependency for two reasons found by inspection: the package is not on
npm, and Node refuses to strip types under `node_modules`. See
[the decision record](../decisions/0001-vendored-core.md).
