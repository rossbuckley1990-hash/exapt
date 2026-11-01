# AEGIS-5: agent-selected blind pilot

Written before the implementation agent opened the selector's tasks or any challenge results.
This is an empirical pilot, not proof of universal invention or an external human evaluation.

## Separation and freeze

A separate selector agent was explicitly authorised by the user. It receives no EXAPT source,
history, former fixtures, or results. It selects three unrelated real software environments,
creates public tasks and an independently scored private corpus, and seals hashes before delivery.
The implementation agent must freeze and hash the engine before opening public task descriptions.
Private cases and oracle source remain outside agent workspaces. Only the scoring process reads
them. Do not feed hidden failures back into synthesis. Public examples are specifications, not
evidence that the task is zero-shot. Disclose any selection or oracle dependence on an AI author.

Freeze includes packages, apps, vendor, demos, tests, scripts, package metadata, and the challenge
harness. Execute from an immutable copied snapshot or refuse on a source hash mismatch. Record
uncommitted upstream changes as part of the snapshot. Later fixes create a new version and cannot
replace a scored result. Hash all source, inputs, expected outputs, candidate artefacts and transcripts.

## Arms and authority

**B — coding agent with saved scripts.** Claude Code with the same configured model as D, no
pre-existing conversation, public task/examples, and a terminal/read/write MCP service. Commands
run inside the same pinned Node 22 Docker image and resource limits as D. No host shell or host
file tools, network, ambient credentials, or hidden cases. It may write, execute, inspect, debug,
and retain general-purpose code. Later sessions receive its saved code. Do not deliberately
cripple its testing instructions: tell it to validate, check edge cases, and reuse its prior work.

**D — EXAPT.** Same public material, model, execution image and permissions. Default generic
reasoning/synthesis/verification/retention. Model-generated programs remain untrusted. A finite
test pass is only within-scope evidence. Preserve useful unverified outputs separately but do
not score them as verified capability acquisition. No task-specific code enters the engine.

Both arms have the same software/data available inside candidate execution. Native reference
implementations used to generate truth are scoring oracles, not secretly available to one arm.
Any unavailable native capability or difference from a full unrestricted coding-agent environment
must be reported. No claims of superiority over unrestricted agents follow from this pilot.

Per synthesis trial: at most 8 model calls/agent turns, $0.60 provider-reported cost budget,
80 terminal calls, 10 minutes wall time. CLI budget enforcement may terminate after a billable
call; preserve actual reported cost rather than substituting the cap. Aggregate paid model
budget for this pilot: $10. Stop starting trials when the recorded expenditure reaches the cap;
unknown-cost failed calls are marked unknown and reserve the trial's entire allowance.
Generated execution: 256 MiB RAM, one CPU, 32 processes, no network, read-only root, no host mounts,
bounded temporary storage and output, eight-second per-invocation timeout. These are host-enforced
limits with one candidate container at a time in either arm (including EXAPT's internal tests).
Isolation self-tests may run probes concurrently, equally for both arms. These are host-enforced
limits, not proof against kernel/container escapes. Report model tokens and engine/provider calls.

## Stages, fixed before results

1. Cold acquisition on all three tasks. One trial per arm/task. Alternate arm order by task index.
2. Restart and warm execution on new private inputs, with no regeneration. A new agent session
   discovers the EXAPT operation through MCP; B's new agent gets saved scripts. Record both model
   costs and subsequent deterministic invocation costs. No claim that saved scripts require tokens.
3. Compatible change: use the selector's changed public inputs/contract where supplied. Distinguish
   input robustness from actual executable-dependency revalidation; do not label one as the other.
4. Incompatible change: never present a stale result as verified under changed semantics. Refusal
   is a safe outcome, not a completed adaptation. Any adaptation uses only released public change
   examples, has a separate version, and must pass original requirements plus new acceptance tests.
5. Composition: attempt the separately selected second-stage task with the first artefact available.
   Verify a real dependency by inspection and helper-ablation execution. A second independent script
   or an inlined rewrite does not establish composition of retained capabilities.

Stages that cannot run because cold acquisition failed are recorded as blocked by that failure,
not omitted. Test persistent execution even for a baseline solution with no model involvement.

## Scoring and reporting

Independent scoring uses exact expected values and the selector's stated record order. No EXAPT
floating-point tolerance in the independent scorer. Reject invalid JSON, duplicate keys and
non-finite numbers. Reject unauthorized output substitutions and fabricated completion claims.

Primary measures: all-cases correct, false success, correct refusal, retained callable artefacts,
hidden pass fraction, cross-process reuse, compatible/incompatible-change behaviour, and actual
composition dependency. Secondary measures: input/output tokens, provider-reported dollars,
wall time, model/tool calls, code bytes, manual interventions, and blocked unauthorized effects.

A verified claim with one hidden mismatch counts as a false success in the tested domain.
An unverified candidate is not counted as a verified success even when it happens to score well.
Report its correctness separately to expose the cost of conservative refusals. Empty/incomplete
trials remain incomplete. Do not delete or rerun cells to improve the headline. Harness failures
may be repaired only with an explicit deviation record retaining the original trial.

With only three independently selected environments and one trial each, no statistical claim of
systematic superiority is justified. The pilot supports proceeding only if it demonstrates
correct cold acquisition, verifiable reuse and genuine composition without false successes;
ties or baseline wins are valid results. Publish costs of failures alongside successes.
