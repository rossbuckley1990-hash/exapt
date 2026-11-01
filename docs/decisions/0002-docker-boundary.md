# 2. Generated code runs only in a disposable container

RightClick X's native sandbox is right for known programs but does not suit untrusted generated code. On
macOS it starts from `(allow default)`, and memory and process limits are sampled by a watchdog, not
enforced by the kernel. Docker's cgroups enforce those limits, and passing source over stdin means no
host path is mounted at all.

There is no fallback. Where the boundary cannot be established and self-tested, generated code is
refused. This costs a Docker dependency, even for the deterministic demonstrations. A container start
of about 0.12 seconds made one container per test case affordable.
