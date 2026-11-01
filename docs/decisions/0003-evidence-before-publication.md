# 3. A capability is callable only at the top evidence level

Anything below `verified-in-domain` is retained for inspection and cannot be invoked, by anyone. This is
strict, and the benchmark shows what it costs: EXAPT refused several correct candidates, and on tasks
with no value-level oracle it cannot succeed by design.

The alternative is an agent acting on a program nothing has checked. An agent with a terminal already
offers that, and more cheaply. EXAPT's reason to exist is that its claims can be relied on, so a refusal
is the right failure. The next priority is to reduce false refusals without weakening this rule.
