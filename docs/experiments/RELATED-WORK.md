# Related work

Checked in November 2026, before any claim of difference. This is a targeted search, not a survey.
Figures below come from secondary summaries unless stated, and were not independently verified.

## What already exists

- **Agents that build their own tools.** [Alita](https://arxiv.org/pdf/2510.23601v1) and its successor
  ALITA-G generate tools at runtime and package them as MCP servers for reuse, including by other
  agents. [Mem²Evolve](https://arxiv.org/pdf/2604.10923) describes this class of tool-generative
  systems. Generated, persistent, cross-agent tools are **not new**, and EXAPT does not claim they are.
- **Generated tools with tests.** ToolMaker uses a verification loop with unit tests.
  [Tool-Genesis](https://www.themoonlight.io/review/tool-genesis-a-task-driven-tool-creation-benchmark-for-self-evolving-language-agent)
  is a benchmark for tool creation from task descriptions.
- **Counterexample-guided synthesis with models.** [Jha et al. (2023)](https://arxiv.org/pdf/2309.16436)
  use an LLM as learner and an SMT solver as verifier. [ExVerus](https://icml.cc/virtual/2026/poster/65247)
  applies counterexample reasoning to proof repair. EXAPT's loop is an instance of this idea, with
  testing in place of proof, so it gives weaker guarantees than either.
- **Programming by example.** [PROSE and FlashFill](https://www.microsoft.com/en-us/research/?p=360923)
  and [FlashFill++](https://api.crossref.org/works/10.1145%2F3571226) do record transformation by
  example at far greater depth than EXAPT's lens search, which is a small and shallow relative.

## What may be different

Only as hypotheses. None was found in this search, which was not exhaustive.

- Oracles and test generators mined from the capability graph, so that an unrelated program becomes
  the verifier of a new one.
- Interface contracts established by perturbing a program, rather than from its documentation.
- Behaviour witnesses that catch a dependency's change in meaning when its interface has not changed.
- Refusal as a first-class outcome: not constructible, unverifiable, and not established.

The [benchmark](BENCHMARK.md) tests whether these add value. It does not support a claim of superiority.
