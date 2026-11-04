---
description: "Use explicit Python harness APIs instead of duplicating host tools"
scope: "tool:bash"
interruptMode: never
---

Python commands are fresh processes. Import `proto_harness as harness`; NEVER assume earlier variables persist.

- Reuse `harness.symbols`, `harness.block_range`, `harness.tool`, `harness.completion` and `harness.agent` instead of duplicating host parsing or orchestration.
- Use `harness.fs.read` / `replace` / `write` for atomic, stale-guarded host edits. Re-read after `StaleWriteError`; NEVER force an obsolete write.
- Choose `harness.store` for selected values; choose an explicitly named `harness.kernel(...)` for a whole warm namespace. Inspect definitions before redefining a helper there.
- Internal URLs belong to host tools: `harness.tool.read({"path": "skill://name"})`. Plain file APIs take filesystem paths.
