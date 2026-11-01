# Real-world experiment: a field-level data-flow certificate for black-box software

Run on this machine, 2026-11-01. Model: none. Every conclusion below comes from EXAPT's contract
miner running a real program in its sandbox, plus a recomputation that imports EXAPT's own `digest`
function rather than reimplementing it.

## The problem

You are about to send a dataset to a program you do not control — a vendor CLI, a pipeline step, a
third-party ETL binary, a tool in a Docker image. You cannot read its source. You need to know
**which fields it actually consumes**, so you can send the minimum and no more.

This is unsolved today. Static analysis needs source. Dynamic taint tracking needs instrumentation
and is research-grade. Vendors assert it contractually and nobody checks. Meanwhile data
minimisation is a legal obligation (GDPR Art. 5(1)(c)), and "why does changing this config value do
nothing" is a daily debugging pain that is the same question from the other side.

## What EXAPT already had

Three things in `packages/capability-universe/miner.ts`, none of which anyone combines:

- `requiredFields` — established by **deleting** each field and seeing whether the program refuses
- `influentialFields` — established by **perturbing** each field and seeing whether the output changes
- `behaviour = digest({tool, outputs})` — a hash of outputs on fixed positive samples

A field that is optional and not influential is not read. Strip every such field and, if the digest
does not move, you have machine-checked evidence that the removed data was never consumed.

## Target

`high-value-extract`, a jq pipeline step of the kind that appears in real data engineering: read an
NDJSON transaction feed, keep rows where `amount > 1000`, project onto `{id, amount, region}`. Its
`--help` documents two example records. The feed carries seven fields, four of them personal
identifiers. All PII in the dataset is synthetic (`.invalid` domains, `000-xx-xxxx` SSNs).

## Result: 18 probes, zero model calls

```
input repr  : ndjson
all fields  : id(string), name(string), email(string), phone(string), ssn(string),
              amount(decimal), region(string)
REQUIRED    : ["amount"]
OPTIONAL    : ["id","name","email","phone","ssn","region"]
INFLUENTIAL : ["id","amount","region"]
BEHAVIOUR   : a5b5881a5f91c523ed80a501d7644092412774fe8e7dabff67949dfb7621fa0f
```

Claims EXAPT recorded, all `experimentally-supported` or `observed`:

- `requires fields amount` — removing it made the program refuse
- `output depends on id, amount, region` — perturbing each one changed the output
- `amount accepts fractional values` — every sample was whole, so the program was asked
- `refuses scrambled bytes`

**Provably unread: `name`, `email`, `phone`, `ssn`.** EXAPT has no concept of what a personal
identifier is. It tested all seven fields identically and the four PII fields fell out as having no
observable effect.

### The certificate

| | |
|---|---|
| Baseline digest reproduced from the stored contract | `a5b5881a5f91c523` — matches |
| Digest after stripping all four unread fields | `a5b5881a5f91c523` — **unchanged** |
| Full 12-record feed, output identical after stripping | **true** (6 rows both ways, byte-for-byte) |
| Feed size before → after | 1,694 → 553 bytes |
| **Personal data removed** | **1,141 bytes** |

```
before: {"id":"TX-1001","name":"Ava Okonkwo","email":"aokonkwo@corp.invalid",
         "phone":"+1-555-0100","ssn":"000-10-1000","amount":1200,"region":"EMEA"}
after:  {"id":"TX-1001","amount":1200,"region":"EMEA"}
```

### Teeth: the detector discriminates

A digest that never moves proves nothing. Nine checks, all pass:

| Case | Digest moved | Expected | |
|---|---|---|---|
| reproduce stored digest | no | matches | PASS |
| strip all unread fields | no | holds | PASS |
| perturb `name` | no | holds | PASS |
| perturb `email` | no | holds | PASS |
| perturb `phone` | no | holds | PASS |
| perturb `ssn` | no | holds | PASS |
| perturb `id` | **yes** → `111fdd739c600946` | moves | PASS |
| perturb `amount` | **yes** → `dac8dbf639c8d3f5` | moves | PASS |
| perturb `region` | **yes** → `6638fbf6ad317c76` | moves | PASS |

Each read field produced a *distinct* digest. The instrument is sensitive exactly where it should be
and silent exactly where it should be.

## What is proven, and what is not

**Proven:** this program's output does not depend on `name`, `email`, `phone` or `ssn`, on the
sampled inputs. Removing them changes nothing. Therefore they were not necessary, and the feed can
be reduced by 67% before it is sent anywhere.

That claim is sufficient for data minimisation, and note that it does not depend on trusting the
program's intentions. You do not need to know whether a tool *would* leak a field once you have
established it does not *need* it — the remedy is to not send it.

**Not proven, and this is the important limitation:**

1. **The certificate is scoped to the sampled inputs.** `influentialFields` is established by
   perturbing two records taken from the program's `--help`. A field used only conditionally —
   read when `region == "AMER"`, say — could be missed entirely. EXAPT names this correctly
   elsewhere in its vocabulary (`verified-within-scope`, `verified-in-domain`); a minimisation
   certificate needs the same scope stamp, and should state how many and which records were probed.
   Two records is thin.
2. **Output-independence is not non-exfiltration.** During EXAPT's probes the program ran with
   network denied, no host mounts and a read-only root, so there was no out-of-band channel. In
   production, unconstrained, a program could read a field and leak it without its stdout changing.
   The containment makes the *probe* clean; it says nothing about the deployed program.
3. **Perturbation is coarse.** Numeric fields get `+1`, others get a trailing `x`. A program whose
   behaviour turns on a specific value rather than a field's presence could evade detection.
4. **The target is a jq wrapper I wrote**, not a pristine vendor binary. The mechanism is proven;
   the optics are weaker than they would be against a real third-party tool.
5. One program, one dataset, one run. No variance.

## A defect found on the way

`ToolContract.options` is documented as *"Documented options that changed what the program accepts
or does"*, but `miner.ts` lines 143-146 never test options behaviourally — they only scrape value
lists out of the description text and record them. The field asserts experimental support it does
not have. The `Claim` status `"contradicted"` is likewise declared in `types.ts:30` and never
assigned anywhere in the codebase.

Both are cheap to fix and both would extend this experiment directly: testing options
behaviourally is the same perturb-and-observe move applied to flags, and it would turn this into an
audit of which documented flags actually do anything.

## Why this is the non-obvious use

EXAPT was built to acquire missing capabilities. The miner is a means to that end — it establishes
what a program really does so a workflow can be planned through it. But an instrument that
establishes, by experiment and with a reproducible digest, **what a closed-source program actually
reads** is valuable on its own, and it is the part nobody would think to point at a compliance or
supply-chain problem.

The capability was already in the codebase. Nothing was extended to produce this result.
