---
description: "In the Python kernel, reuse prelude primitives and already-defined functions instead of hand-rolling file and search helpers"
scope: "tool:kernel"
interruptMode: never
---

The kernel namespace persists across calls, and the prelude already ships the common primitives.

## Before defining a helper

- Run `defs()` — functions and classes defined in earlier cells are still bound; reuse them, and only re-define to change them.
- Reach for the prelude API instead of raw file plumbing: `write()`, `edit()`, `edit_block()`, `block_range()`, `replace()`, `symbols()`, `display()`, `env()`, `output()`, `tool.<name>()`, `agent()`, `completion()`, `parallel()`/`pipeline()`.

## Never shadow prelude names

```python
# Bad — silently replaces the prelude primitive for every later cell
def write(path, content):
    open(path, "w").write(content)

# Good — give helpers distinct names
def write_report(path, content):
    ...
```

## Hand-rolled patterns to drop

- Manual find-and-replace over file text → `replace(path, old, new, count=1)`.
- Scanning files for declarations → `symbols(path)`.
