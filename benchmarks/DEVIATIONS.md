# Deviations from the preregistration

1. **Harness crash on tasks with no `programs/`.** The first launch from `prereg-v1` crashed when
   building a workspace for F3, which has no programs directory. The harness now creates an empty one.
   Tasks, scoring and arms are unchanged. Sessions in flight at the crash were lost and never scored.
   Trials already written stayed, and the run resumed from them.

2. **F1-relay-201 cold, arms A and B.** This session was killed by the cleanup after the first crash in
   deviation 1, so it is recorded as incomplete and is not a measure of the agent. Its `out/` directory
   was written before the kill, so arm B's later sessions on this task inherited a partial session.
   It stays in the results as it is, as the preregistration requires.
