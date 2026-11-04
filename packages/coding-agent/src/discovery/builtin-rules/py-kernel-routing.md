---
description: "Keep native Python execution distinct from explicit named harness kernels"
scope: "tool:bash"
interruptMode: never
---

All ordinary Python commands run fresh. Aliases, environment runners, scripts, modules and subprocesses are valid native execution, not kernel bypasses.

- MUST preserve the requested interpreter/environment. Use its executable, activate the project environment or use its normal runner; NEVER substitute an unrelated Python.
- Explicit API: `import proto_harness as harness`. Explicit persistence: `harness.store` or `harness.kernel("name")`; CLI warm entry: `python -m proto_harness.kernel name`.
- `-I`, `-E` and `-S` intentionally opt out of managed startup discovery. NEVER rerun a completed program merely to change execution mode.
