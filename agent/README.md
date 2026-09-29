# Agent layer

Agent runtime, formal Skills, tool adapters, evaluations, and tracing live here.

- [Formal Agent Skills](skills/README.md)
- `runtime/`: Agent task runtime integration
- `tools/`: bounded tool adapters
- `evals/`: reproducible Skill / Agent evaluation inputs
- `tracing/`: Agent execution tracing

Agents do not access business SQLite directly; application-side validation and persistence remain authoritative.
