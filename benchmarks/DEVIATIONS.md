# Deviations from the preregistration

1. **Harness crash on tasks with no `programs/`.** The first launch from `prereg-v1` crashed when
   building a workspace for F3, which has no programs directory. The harness now creates an empty one.
   Tasks, scoring and arms are unchanged. Sessions in flight at the crash were lost and never scored.
   Trials already written stayed, and the run resumed from them.
