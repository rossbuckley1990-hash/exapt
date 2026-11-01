# Troubleshooting

Run `npm run doctor` first. It checks the host and attacks the sandbox.

| You see | It means | Do this |
|---|---|---|
| `generated code cannot run here` | Docker is missing or stopped | Start Docker. EXAPT does not run generated code without it |
| `image ... is not present` | The pinned sandbox image is not local | `npm run setup` |
| `execution boundary failed its self-test` | An attack was not contained | Do not work around it. Read `npm run doctor` |
| `analysis: unverifiable` | Nothing here could check values | Add a program that reads the target back, a corpus with truth, or input/output examples |
| `analysis: not-constructible` | The input does not carry what is needed | Add a source for the listed fields |
| `analysis: underspecified` | The goal is incomplete, or no accepted input is known | Give what the questions ask for; a model can suggest samples for a program |
| `Retained as unverified` | Survived tests, but the evidence is short of verified | Read the limitations; add evidence. It cannot be invoked |
| `dependency-changed` | A program it relies on changed in a way that matters | `exapt repair <id>`, once the release is understood |
| `path-not-allowed` | An agent named a file outside the operator's roots | Add the root to `dataRoots`, or pass the data inline |
| `no model is configured` in notes | The deterministic search could not do it | Configure a model; see [connecting](CONNECTING.md) |
| A program shows `no accepted input observed` | Nothing was found that it accepts | Give a sample in the goal, or configure a model |
