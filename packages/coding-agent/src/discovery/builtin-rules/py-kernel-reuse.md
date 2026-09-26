---
description: "In the Python kernel, reuse prelude primitives and already-defined functions instead of hand-rolling file and search helpers"
scope: "tool:bash"
interruptMode: never
---

The kernel namespace persists across calls, and the prelude already ships the common primitives.

## Before defining a helper

- Run `defs()` — functions and classes defined in earlier cells are still bound; reuse them, and only re-define to change them.
- Reach for the prelude API instead of raw file plumbing: `block_range()`, `symbols()`, `display()`, `env()`, `output()`, `tool.<name>()`, `agent()`, `completion()`, `parallel()`/`pipeline()`. File edits are plain `open`/`Path` — every mutation is diffed in Status and guarded (StaleWriteError → re-read).

## Never shadow prelude names

```python
# Bad — silently replaces the prelude primitive for every later cell
def symbols(path):
    return ""

# Good — give helpers distinct names
def symbols_summary(path):
    ...
```

## Hand-rolled patterns to drop

- Scanning files for declarations → `symbols(path)`.
- Resolving internal URIs by hand → `tool.read({"path": "skill://name"})` or bash URI arguments. Raw file APIs take filesystem paths; bash `env` can pass resolved paths into local cells.
